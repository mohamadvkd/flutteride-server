const express = require('express');
const multer = require('multer');
const axios = require('axios');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

// ============================================================
// إعدادات GitHub OAuth
// ============================================================
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI || 'https://flutteride-server-hu3g.onrender.com/auth/callback';

// ============================================================
// تخزين مؤقت لحالة البناء
// ============================================================
const builds = {};

// ============================================================
// OAuth - بدء عملية تسجيل الدخول
// ============================================================
app.get('/auth/login', (req, res) => {
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${GITHUB_REDIRECT_URI}&scope=repo%20workflow%20user&prompt=select_account`;
    res.json({ auth_url: authUrl });
});

// ============================================================
// OAuth - Callback بعد تسجيل الدخول
// ============================================================
app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    
    if (!code) {
        return res.status(400).send('Code is required');
    }
    
    try {
        const tokenRes = await axios.post('https://github.com/login/oauth/access_token', {
            client_id: GITHUB_CLIENT_ID,
            client_secret: GITHUB_CLIENT_SECRET,
            code: code,
            redirect_uri: GITHUB_REDIRECT_URI
        }, {
            headers: { 'Accept': 'application/json' }
        });
        
        const accessToken = tokenRes.data.access_token;
        const refreshToken = tokenRes.data.refresh_token;
        
        const userRes = await axios.get('https://api.github.com/user', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        const username = userRes.data.login;
        
        const redirectUrl = `flutteride://auth/callback?access_token=${accessToken}&refresh_token=${refreshToken}&username=${username}`;
        res.redirect(302, redirectUrl);
        
    } catch (error) {
        console.error('OAuth Error:', error.response?.data || error.message);
        res.status(500).send('Authentication failed: ' + (error.response?.data?.error_description || error.message));
    }
});

// ============================================================
// OAuth - تبادل الكود للحصول على التوكن (للتطبيق)
// ============================================================
app.post('/auth/token', async (req, res) => {
    const { code } = req.body;
    
    if (!code) {
        return res.status(400).json({ error: 'Code is required' });
    }
    
    try {
        const tokenRes = await axios.post('https://github.com/login/oauth/access_token', {
            client_id: GITHUB_CLIENT_ID,
            client_secret: GITHUB_CLIENT_SECRET,
            code: code,
            redirect_uri: GITHUB_REDIRECT_URI
        }, {
            headers: { 'Accept': 'application/json' }
        });
        
        const accessToken = tokenRes.data.access_token;
        const refreshToken = tokenRes.data.refresh_token;
        
        const userRes = await axios.get('https://api.github.com/user', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        res.json({
            access_token: accessToken,
            refresh_token: refreshToken,
            username: userRes.data.login
        });
        
    } catch (error) {
        console.error('Token exchange error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to exchange code for token' });
    }
});

// ============================================================
// OAuth - تجديد التوكن (Refresh Token)
// ============================================================
app.post('/auth/refresh', async (req, res) => {
    const { refresh_token } = req.body;
    
    if (!refresh_token) {
        return res.status(400).json({ error: 'Refresh token is required' });
    }
    
    try {
        const tokenRes = await axios.post('https://github.com/login/oauth/access_token', {
            client_id: GITHUB_CLIENT_ID,
            client_secret: GITHUB_CLIENT_SECRET,
            refresh_token: refresh_token,
            grant_type: 'refresh_token'
        }, {
            headers: { 'Accept': 'application/json' }
        });
        
        const accessToken = tokenRes.data.access_token;
        const newRefreshToken = tokenRes.data.refresh_token || refresh_token;
        
        res.json({
            access_token: accessToken,
            refresh_token: newRefreshToken
        });
        
    } catch (error) {
        console.error('Refresh token error:', error.response?.data || error.message);
        res.status(401).json({ error: 'Invalid refresh token' });
    }
});

// ============================================================
// استقبال ZIP وبدء البناء (مع توكن المستخدم)
// ============================================================
app.post('/build', upload.single('file'), async (req, res) => {
    try {
        const zipFile = req.file;
        const userToken = req.headers.authorization;
        
        if (!zipFile) {
            return res.status(400).json({ status: 'error', message: 'لم يتم إرسال ملف' });
        }
        
        if (!userToken) {
            return res.status(401).json({ status: 'error', message: 'غير مصرح: يرجى تسجيل الدخول' });
        }
        
        const token = userToken.replace('Bearer ', '');
        
        let userInfo;
        try {
            const userRes = await axios.get('https://api.github.com/user', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            userInfo = userRes.data;
        } catch (error) {
            if (error.response && error.response.status === 401) {
                return res.status(401).json({ status: 'error', message: 'توكن منتهي، يرجى تحديث الجلسة' });
            }
            return res.status(401).json({ status: 'error', message: 'توكن غير صالح، يرجى تسجيل الدخول مرة أخرى' });
        }
        
        const buildId = Date.now().toString();
        const username = userInfo.login;
        
        builds[buildId] = {
            status: 'uploading',
            downloadUrl: null,
            error: null,
            logs: '',
            started: new Date(),
            username: username,
            userToken: token
        };
        
        res.json({ status: 'building', build_id: buildId });
        
        processBuild(buildId, zipFile);
        
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ============================================================
// التحقق من حالة البناء
// ============================================================
app.get('/status/:buildId', (req, res) => {
    const buildId = req.params.buildId;
    const build = builds[buildId];
    
    if (!build) {
        return res.json({ status: 'error', message: 'رقم البناء غير موجود' });
    }
    
    res.json({
        status: build.status,
        download_url: build.downloadUrl,
        error: build.error,
        logs: build.logs || ''
    });
    
    if (build.status === 'success' || build.status === 'error') {
        const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
        for (const id in builds) {
            if (builds[id].started.getTime() < thirtyMinAgo) {
                delete builds[id];
            }
        }
    }
});

// ============================================================
// تنفيذ البناء في الخلفية
// ============================================================
async function processBuild(buildId, zipFile) {
    const build = builds[buildId];
    const token = build.userToken;
    const username = build.username;
    const repoName = `FlutterIDE-Builds-${username}`;
    const apiBase = `https://api.github.com/repos/${username}/${repoName}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'FlutterIDE-Server'
    };
    
    try {
        build.status = 'extracting';
        build.logs += 'بدء عملية البناء\n';
        console.log(`[${buildId}] بدء عملية البناء للمستخدم ${username}`);
        
        build.logs += 'فك ضغط المشروع...\n';
        console.log(`[${buildId}] فك ضغط الملف...`);
        const zip = new AdmZip(zipFile.path);
        const projectDir = path.join(__dirname, 'temp', buildId);
        zip.extractAllTo(projectDir, true);
        build.logs += 'تم فك ضغط المشروع\n';
        
        // التحقق من وجود المستودع وإنشائه إذا لزم الأمر
        build.logs += 'التحقق من وجود المستودع...\n';
        let repoExists = false;
        try {
            await axios.get(apiBase, { headers });
            repoExists = true;
            build.logs += 'المستودع موجود بالفعل، سيتم تحديثه...\n';
        } catch (e) {
            if (e.response && e.response.status === 404) {
                build.logs += 'إنشاء مستودع جديد مع ملف README...\n';
                try {
                    await axios.post('https://api.github.com/user/repos', {
                        name: repoName,
                        private: true,
                        auto_init: true,
                        description: 'FlutterIDE builds'
                    }, { headers });
                    build.logs += 'تم إنشاء المستودع بنجاح مع ملف README\n';
                    repoExists = true;
                } catch (createError) {
                    if (createError.response && createError.response.status === 409) {
                        build.logs += 'المستودع موجود بالفعل (تضارب 409)، متابعة الرفع...\n';
                        repoExists = true;
                    } else {
                        throw createError;
                    }
                }
            } else {
                throw e;
            }
        }
        
        if (!repoExists) {
            throw new Error('فشل في إنشاء المستودع أو الوصول إليه');
        }
        
        build.status = 'uploading_to_github';
        build.logs += 'رفع الملفات  ...\n';
        console.log(`[${buildId}] رفع الملفات  ...`);
        await uploadToGitHub(projectDir, repoName, username, token, buildId);
        build.logs += 'تم رفع الملفات بنجاح\n';
        console.log(`[${buildId}] تم رفع الملفات بنجاح`);
        
        build.status = 'building';
        build.logs += 'انتظار اكتمال البناء (قد يستغرق من 3-7 دقائق )  \n';
        console.log(`[${buildId}] انتظار GitHub Actions...`);
        const result = await waitForBuild(repoName, username, token, buildId);
        
        try {
            fs.rmSync(zipFile.path);
            fs.rmSync(projectDir, { recursive: true, force: true });
        } catch (e) {}
        
        if (result.success) {
            build.status = 'success';
            build.downloadUrl = result.downloadUrl;
            build.logs += 'تم البناء بنجاح\n';
            console.log(`[${buildId}] تم البناء بنجاح! رابط التحميل: ${result.downloadUrl}`);
        } else {
            build.status = 'error';
            build.error = result.error;
            build.logs += result.logs || 'فشل البناء على GitHub Actions\n';
            console.log(`[${buildId}] فشل البناء`);
        }
        
    } catch (error) {
        console.error(`[${buildId}] Error:`, error.message);
        build.status = 'error';
        build.error = error.message;
        build.logs += `خطأ: ${error.message}\n`;
        
        try {
            fs.rmSync(zipFile.path);
        } catch (e) {}
    }
}

// ============================================================
// رفع الملفات إلى GitHub
// ============================================================
async function uploadToGitHub(projectDir, repoName, username, token, buildId) {
    const apiBase = `https://api.github.com/repos/${username}/${repoName}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'FlutterIDE-Server'
    };
    
    const branchName = 'main';
    
    // جلب أحدث commit من الفرع
    let latestCommitSha = null;
    let latestTreeSha = null;
    
    try {
        const branchRes = await axios.get(`${apiBase}/branches/${branchName}`, { headers });
        latestCommitSha = branchRes.data.commit.sha;
        latestTreeSha = branchRes.data.commit.commit.tree.sha;
        builds[buildId].logs += `تم العثور على الفرع الرئيسي\n`;
    } catch (e) {
        builds[buildId].logs += `الفرع الرئيسي غير موجود، سيتم إنشاؤه\n`;
    }
    
    // جمع جميع الملفات من المشروع
    const files = [];
    await collectFiles(projectDir, '', files);
    
    builds[buildId].logs += `جاري رفع ${files.length} ملف...\n`;
    
    // إنشاء blobs لكل ملف
    const blobs = [];
    let blobCount = 0;
    
    for (const file of files) {
        const content = fs.readFileSync(file.path);
        const isBinary = /\.(png|jpg|jpeg|gif|ico|webp|bmp)$/i.test(file.name);
        const encoding = isBinary ? 'base64' : 'utf-8';
        const encodedContent = isBinary ? content.toString('base64') : content.toString('utf-8');
        
        const blobRes = await axios.post(`${apiBase}/git/blobs`, {
            content: encodedContent,
            encoding: encoding
        }, { headers });
        
        blobs.push({
            path: file.relativePath,
            mode: '100644',
            type: 'blob',
            sha: blobRes.data.sha
        });
        
        blobCount++;
        if (blobCount % 10 === 0 || blobCount === files.length) {
            builds[buildId].logs += `تم إنشاء ${blobCount}/${files.length} blob...\n`;
        }
    }
    
    builds[buildId].logs += `تم إنشاء جميع blobs\n`;
    
    // إنشاء شجرة جديدة
    const treeRes = await axios.post(`${apiBase}/git/trees`, {
        tree: blobs,
        base_tree: latestTreeSha
    }, { headers });
    const newTreeSha = treeRes.data.sha;
    
    builds[buildId].logs += `تم إنشاء الشجرة\n`;
    
    // إنشاء commit جديد
    const commitRes = await axios.post(`${apiBase}/git/commits`, {
        message: `Build from FlutterIDE - ${new Date().toISOString()}`,
        tree: newTreeSha,
        parents: latestCommitSha ? [latestCommitSha] : []
    }, { headers });
    const newCommitSha = commitRes.data.sha;
    
    builds[buildId].logs += `تم إنشاء commit\n`;
    
    // تحديث الفرع
    if (latestCommitSha) {
        await axios.patch(`${apiBase}/git/refs/heads/${branchName}`, {
            sha: newCommitSha,
            force: true
        }, { headers });
    } else {
        await axios.post(`${apiBase}/git/refs`, {
            ref: `refs/heads/${branchName}`,
            sha: newCommitSha
        }, { headers });
    }
    
    builds[buildId].logs += `تم تحديث الفرع الرئيسي بنجاح\n`;
    builds[buildId].logs += `تم رفع ${files.length} ملف بنجاح\n`;
}

async function collectFiles(dirPath, relativePath, files) {
    const items = fs.readdirSync(dirPath);
    
    for (const item of items) {
        if (item === '.gitignore') continue;
        
        const fullPath = path.join(dirPath, item);
        const relPath = relativePath ? `${relativePath}/${item}` : item;
        
        if (fs.statSync(fullPath).isDirectory()) {
            await collectFiles(fullPath, relPath, files);
        } else {
            files.push({
                path: fullPath,
                name: item,
                relativePath: relPath
            });
        }
    }
}

// ============================================================
// انتظار بناء GitHub Actions وجلب APK من Artifact
// ============================================================
async function waitForBuild(repoName, username, token, buildId) {
    const apiBase = `https://api.github.com/repos/${username}/${repoName}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'FlutterIDE-Server'
    };
    
    const initialRuns = await axios.get(`${apiBase}/actions/runs?per_page=1`, { headers });
    const lastRunBefore = initialRuns.data.workflow_runs[0]?.id || 0;
    
    builds[buildId].logs += `آخر run موجود قبل البناء: ${lastRunBefore}\n`;
    
    for (let i = 0; i < 150; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const runsRes = await axios.get(`${apiBase}/actions/runs?per_page=5`, { headers });
        
        for (const run of runsRes.data.workflow_runs) {
            if (run.id <= lastRunBefore && run.status === 'completed') {
                continue;
            }
            
            builds[buildId].logs += `Run #${run.id}: ${run.status} (${run.conclusion || 'pending'})\n`;
            
            if (run.status === 'completed') {
                if (run.conclusion === 'success') {
                    builds[buildId].logs += `اكتمل البناء بنجاح\n`;
                    
                    // جلب Artifact بدلاً من Release
                    try {
                        const artifactsRes = await axios.get(`${apiBase}/actions/runs/${run.id}/artifacts`, { headers });
                        
                        if (artifactsRes.data.artifacts && artifactsRes.data.artifacts.length > 0) {
                            const artifact = artifactsRes.data.artifacts.find(a => a.name === 'app-release');
                            if (artifact) {
                                // جلب رابط التحميل المباشر لـ Artifact
                                const downloadUrl = artifact.archive_download_url;
                                builds[buildId].logs += `تم العثور على Artifact: ${artifact.name}\n`;
                                return { success: true, downloadUrl: downloadUrl };
                            } else {
                                builds[buildId].logs += `لم يتم العثور على Artifact باسم app-release\n`;
                            }
                        } else {
                            builds[buildId].logs += `لا توجد Artifacts في هذا الـ run\n`;
                        }
                    } catch (artifactErr) {
                        builds[buildId].logs += `فشل في جلب Artifact: ${artifactErr.message}\n`;
                    }
                    
                    return { success: false, error: 'لم يتم العثور على APK', logs: builds[buildId].logs };
                } else {
                    builds[buildId].logs += `فشل البناء (${run.conclusion})\n`;
                    builds[buildId].logs += `جلب سجلات البناء...\n`;
                    
                    try {
                        const logsUrl = `${apiBase}/actions/runs/${run.id}/logs`;
                        const logsRes = await axios.get(logsUrl, { 
                            headers, 
                            responseType: 'arraybuffer'
                        });
                        
                        if (logsRes.data && logsRes.data.length > 0) {
                            const zip = new AdmZip(Buffer.from(logsRes.data));
                            const zipEntries = zip.getEntries();
                            let allLogs = '';
                            
                            for (const entry of zipEntries) {
                                if (!entry.isDirectory) {
                                    allLogs += zip.readAsText(entry) + '\n';
                                }
                            }
                            
                            const logLines = allLogs.split('\n');
                            const errorKeywords = [
                                'error:', 'Error:', 'ERROR:',
                                'FAILURE:', 'FAILED:',
                                'Exception:', 'exception:',
                                'Could not find',
                                'syntax error',
                                'Build failed'
                            ];
                            
                            const relevantLines = [];
                            for (const line of logLines) {
                                for (const keyword of errorKeywords) {
                                    if (line.toLowerCase().includes(keyword.toLowerCase())) {
                                        relevantLines.push(line);
                                        break;
                                    }
                                }
                            }
                            
                            if (relevantLines.length > 0) {
                                builds[buildId].logs += `\nالأخطاء المكتشفة:\n`;
                                for (const line of relevantLines.slice(-30)) {
                                    builds[buildId].logs += `  ${line}\n`;
                                }
                            }
                            
                            builds[buildId].logs += ` سجلات البناء:\n`;
                            const lastLines = logLines.slice(-100);
                            for (const line of lastLines) {
                                if (line.trim().length > 0) {
                                    builds[buildId].logs += `${line}\n`;
                                }
                            }
                        }
                    } catch (logErr) {
                        builds[buildId].logs += `فشل في جلب السجلات\n`;
                    }
                    
                    return { success: false, error: `فشل البناء: ${run.conclusion}`, logs: builds[buildId].logs };
                }
            }
        }
    }
    
    builds[buildId].logs += `انتهت مهلة الانتظار (12.5 دقيقة)\n`;
    return { success: false, error: 'انتهت مهلة الانتظار', logs: builds[buildId].logs };
}

// ============================================================
// صفحة رئيسية
// ============================================================
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'FlutterIDE Server is running' });
});

// ============================================================
// تشغيل الخادم
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`FlutterIDE Server running on port ${PORT}`);
});
