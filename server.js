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
// إعدادات GitHub - التوكن من متغير البيئة في Render
// ============================================================
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'mohamadvkd';
const GITHUB_REPO = process.env.GITHUB_REPO || 'Flutteride';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// ============================================================
// تخزين مؤقت لحالة البناء
// ============================================================
const builds = {};
const pubgets = {};

// ============================================================
// استقبال ZIP وبدء البناء
// ============================================================
app.post('/build', upload.single('file'), async (req, res) => {
    try {
        const zipFile = req.file;
        
        if (!zipFile) {
            return res.status(400).json({ status: 'error', message: 'لم يتم إرسال ملف' });
        }

        const buildId = Date.now().toString();
        
        builds[buildId] = {
            status: 'uploading',
            downloadUrl: null,
            error: null,
            logs: '',
            started: new Date()
        };

        res.json({ status: 'building', build_id: buildId });

        processBuild(buildId, zipFile);

    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ============================================================
// استقبال طلب تنزيل المكتبات (pub get)
// ============================================================
app.post('/pubget', upload.single('file'), async (req, res) => {
    try {
        const zipFile = req.file;
        
        if (!zipFile) {
            return res.status(400).json({ status: 'error', message: 'لم يتم إرسال ملف' });
        }

        const pubgetId = Date.now().toString();
        
        pubgets[pubgetId] = {
            status: 'uploading',
            error: null,
            logs: '',
            started: new Date()
        };

        res.json({ status: 'started', pubget_id: pubgetId });

        processPubGet(pubgetId, zipFile);

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
// التحقق من حالة pub get
// ============================================================
app.get('/pubget-status/:pubgetId', (req, res) => {
    const pubgetId = req.params.pubgetId;
    const pubget = pubgets[pubgetId];
    
    if (!pubget) {
        return res.json({ status: 'error', message: 'رقم العملية غير موجود' });
    }
    
    res.json({
        status: pubget.status,
        error: pubget.error,
        logs: pubget.logs || ''
    });
    
    if (pubget.status === 'success' || pubget.status === 'error') {
        const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
        for (const id in pubgets) {
            if (pubgets[id].started.getTime() < thirtyMinAgo) {
                delete pubgets[id];
            }
        }
    }
});

// ============================================================
// تنفيذ البناء في الخلفية
// ============================================================
async function processBuild(buildId, zipFile) {
    try {
        builds[buildId].status = 'extracting';
        builds[buildId].logs += ' بدء عملية البناء\n';
        console.log(`[${buildId}] بدء عملية البناء`);

        builds[buildId].logs += 'فك ضغط المشروع...\n';
        console.log(`[${buildId}] فك ضغط الملف...`);
        const zip = new AdmZip(zipFile.path);
        const projectDir = path.join(__dirname, 'temp', buildId);
        zip.extractAllTo(projectDir, true);
        builds[buildId].logs += '✓ تم فك ضغط المشروع\n';

        builds[buildId].status = 'uploading_to_github';
        builds[buildId].logs += ' رفع الملفات إلى ...\n';
        console.log(`[${buildId}] رفع الملفات إلى ...`);
        await uploadToGitHub(projectDir, buildId);
        builds[buildId].logs += '✓ تم رفع الملفات بنجاح\n';
        console.log(`[${buildId}] تم رفع الملفات بنجاح`);

        builds[buildId].status = 'building';
        builds[buildId].logs += ' انتظار اكتمال البناء (قد يستغرق 2-7 دقائق )  ...\n';
        console.log(`[${buildId}] انتظار  ...`);
        const result = await waitForBuild(buildId);

        try {
            fs.rmSync(zipFile.path);
            fs.rmSync(projectDir, { recursive: true, force: true });
        } catch (e) {}

        if (result.success) {
            builds[buildId].status = 'success';
            builds[buildId].downloadUrl = result.downloadUrl;
            builds[buildId].logs += ' تم البناء بنجاح!\n';
            builds[buildId].logs += ` رابط التنزيل: ${result.downloadUrl}\n`;
            console.log(`[${buildId}] تم البناء بنجاح!`);
        } else {
            builds[buildId].status = 'error';
            builds[buildId].error = result.error;
            builds[buildId].logs += result.logs || ' فشل البناء   \n';
            console.log(`[${buildId}] فشل البناء`);
        }

    } catch (error) {
        console.error(`[${buildId}] Error:`, error.message);
        builds[buildId].status = 'error';
        builds[buildId].error = error.message;
        builds[buildId].logs += `❌ خطأ: ${error.message}\n`;
        
        try {
            fs.rmSync(zipFile.path);
        } catch (e) {}
    }
}

// ============================================================
// تنفيذ flutter pub get في الخلفية
// ============================================================
async function processPubGet(pubgetId, zipFile) {
    try {
        pubgets[pubgetId].status = 'extracting';
        pubgets[pubgetId].logs += ' بدء تنزيل المكتبات\n';
        console.log(`[${pubgetId}] بدء تنزيل المكتبات`);

        pubgets[pubgetId].logs += ' فك ضغط المشروع...\n';
        console.log(`[${pubgetId}] فك ضغط الملف...`);
        const zip = new AdmZip(zipFile.path);
        const projectDir = path.join(__dirname, 'temp_pubget', pubgetId);
        zip.extractAllTo(projectDir, true);
        pubgets[pubgetId].logs += '✓ تم فك ضغط المشروع\n';

        pubgets[pubgetId].status = 'uploading_to_github';
        pubgets[pubgetId].logs += ' رفع الملفات  ...\n';
        console.log(`[${pubgetId}] رفع الملفات إلى GitHub...`);
        await uploadToGitHub(projectDir, pubgetId);
        pubgets[pubgetId].logs += '✓ تم رفع الملفات بنجاح\n';
        console.log(`[${pubgetId}] تم رفع الملفات بنجاح`);

        pubgets[pubgetId].status = 'pubgetting';
        pubgets[pubgetId].logs += ' انتظار اكتمال تنزيل المكتبات من...\n';
        console.log(`[${pubgetId}] انتظار تنزيل المكتبات...`);
        const result = await waitForPubGet(pubgetId);

        try {
            fs.rmSync(zipFile.path);
            fs.rmSync(projectDir, { recursive: true, force: true });
        } catch (e) {}

        if (result.success) {
            pubgets[pubgetId].status = 'success';
            pubgets[pubgetId].logs += ' تم تنزيل المكتبات بنجاح!\n';
            console.log(`[${pubgetId}] تم تنزيل المكتبات بنجاح!`);
        } else {
            pubgets[pubgetId].status = 'error';
            pubgets[pubgetId].error = result.error;
            pubgets[pubgetId].logs += result.logs || ' فشل تنزيل المكتبات\n';
            console.log(`[${pubgetId}] فشل تنزيل المكتبات`);
        }

    } catch (error) {
        console.error(`[${pubgetId}] Error:`, error.message);
        pubgets[pubgetId].status = 'error';
        pubgets[pubgetId].error = error.message;
        pubgets[pubgetId].logs += `❌ خطأ: ${error.message}\n`;
        
        try {
            fs.rmSync(zipFile.path);
        } catch (e) {}
    }
}

// ============================================================
// دالة رفع الملفات إلى GitHub
// ============================================================
async function uploadToGitHub(projectDir, buildId) {
    const apiBase = `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}`;
    const headers = {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'FlutterIDE-Server'
    };

    const branchRes = await axios.get(`${apiBase}/branches/${GITHUB_BRANCH}`, { headers });
    const latestSha = branchRes.data.commit.sha;
    const treeSha = branchRes.data.commit.commit.tree.sha;

    const treeItems = [];
    await createTreeItems(projectDir, '', treeItems, headers, apiBase, buildId);

    const treeRes = await axios.post(`${apiBase}/git/trees`, {
        tree: treeItems,
        base_tree: treeSha
    }, { headers });

    const commitRes = await axios.post(`${apiBase}/git/commits`, {
        message: `Build from FlutterIDE - ${new Date().toISOString()}`,
        tree: treeRes.data.sha,
        parents: [latestSha]
    }, { headers });

    await axios.patch(`${apiBase}/git/refs/heads/${GITHUB_BRANCH}`, {
        sha: commitRes.data.sha
    }, { headers });
}

async function createTreeItems(dirPath, basePath, treeItems, headers, apiBase, buildId) {
    const items = fs.readdirSync(dirPath);
    
    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const relativePath = basePath ? `${basePath}/${item}` : item;
        
        if (fs.statSync(fullPath).isDirectory()) {
            await createTreeItems(fullPath, relativePath, treeItems, headers, apiBase, buildId);
        } else {
            const content = fs.readFileSync(fullPath);
            const isBinary = /\.(png|jpg|jpeg|gif|ico|webp|bmp)$/i.test(item);
            const encoding = isBinary ? 'base64' : 'utf-8';
            const encodedContent = isBinary ? content.toString('base64') : content.toString('utf-8');
            
            const blobRes = await axios.post(`${apiBase}/git/blobs`, {
                content: encodedContent,
                encoding: encoding
            }, { headers });
            
            treeItems.push({
                path: relativePath,
                mode: '100644',
                type: 'blob',
                sha: blobRes.data.sha
            });
        }
    }
}

// ============================================================
// انتظار بناء GitHub Actions
// ============================================================
async function waitForBuild(buildId) {
    const apiBase = `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}`;
    const headers = {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'FlutterIDE-Server'
    };

    const initialRuns = await axios.get(`${apiBase}/actions/runs?branch=${GITHUB_BRANCH}&per_page=1`, { headers });
    const lastRunBefore = initialRuns.data.workflow_runs[0]?.id || 0;
    
    builds[buildId].logs += `run...: ${lastRunBefore}\n`;

    for (let i = 0; i < 150; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const elapsed = (i + 1) * 5;
        if (elapsed % 30 === 0) {
            builds[buildId].logs += ` انتظار البناء... (${elapsed} ثانية)\n`;
        }

        const runsRes = await axios.get(`${apiBase}/actions/runs?branch=${GITHUB_BRANCH}&per_page=5`, { headers });
        
        for (const run of runsRes.data.workflow_runs) {
            if (run.id <= lastRunBefore && run.status === 'completed') {
                continue;
            }
            
            builds[buildId].logs += ` Run #${run.id}: ${run.status} (${run.conclusion || 'pending'})\n`;
            
            if (run.status === 'completed') {
                if (run.conclusion === 'success') {
                    builds[buildId].logs += `اكتمل البناء بنجاح!\n`;
                    const releasesRes = await axios.get(`${apiBase}/releases?per_page=1`, { headers });
                    if (releasesRes.data.length > 0 && releasesRes.data[0].assets.length > 0) {
                        const downloadUrl = releasesRes.data[0].assets[0].browser_download_url;
                        return { success: true, downloadUrl: downloadUrl };
                    }
                    return { success: false, error: 'لم يتم العثور على ملف APK', logs: builds[buildId].logs };
                } else {
                    builds[buildId].logs += ` فشل البناء (${run.conclusion})\n`;
                    builds[buildId].logs += ` جلب سجلات البناء...\n`;
                    
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
                                builds[buildId].logs += `\n الأخطاء المكتشفة:\n`;
                                for (const line of relevantLines.slice(-30)) {
                                    builds[buildId].logs += `  ❌ ${line}\n`;
                                }
                            }
                            
                            builds[buildId].logs += `\n   سطر سجلات البناء:\n`;
                            const lastLines = logLines.slice(-100);
                            for (const line of lastLines) {
                                if (line.trim().length > 0) {
                                    builds[buildId].logs += `${line}\n`;
                                }
                            }
                        }
                    } catch (logErr) {
                        builds[buildId].logs += ` فشل في جلب السجلات \n`;
                    }
                    
                    return { success: false, error: `فشل البناء: ${run.conclusion}`, logs: builds[buildId].logs };
                }
            }
        }
    }
    
    builds[buildId].logs += ` انتهت مهلة الانتظار (12.5 دقيقة)\n`;
    return { success: false, error: 'انتهت مهلة الانتظار', logs: builds[buildId].logs };
}

// ============================================================
// انتظار تنزيل المكتبات من GitHub Actions
// ============================================================
async function waitForPubGet(pubgetId) {
    const apiBase = `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}`;
    const headers = {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'FlutterIDE-Server'
    };

    const initialRuns = await axios.get(`${apiBase}/actions/runs?branch=${GITHUB_BRANCH}&per_page=1`, { headers });
    const lastRunBefore = initialRuns.data.workflow_runs[0]?.id || 0;
    
    pubgets[pubgetId].logs += `run...: ${lastRunBefore}\n`;

    for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const runsRes = await axios.get(`${apiBase}/actions/runs?branch=${GITHUB_BRANCH}&per_page=5`, { headers });
        
        for (const run of runsRes.data.workflow_runs) {
            if (run.id <= lastRunBefore && run.status === 'completed') {
                continue;
            }
            
            pubgets[pubgetId].logs += ` Run #${run.id}: ${run.status}\n`;
            
            if (run.status === 'completed') {
                if (run.conclusion === 'success') {
                    pubgets[pubgetId].logs += ` اكتمل تنزيل المكتبات بنجاح!\n`;
                    return { success: true };
                } else {
                    pubgets[pubgetId].logs += `فشل تنزيل المكتبات (${run.conclusion})\n`;
                    return { success: false, error: `فشل تنزيل المكتبات: ${run.conclusion}`, logs: pubgets[pubgetId].logs };
                }
            }
        }
    }
    
    pubgets[pubgetId].logs += ` انتهت مهلة الانتظار\n`;
    return { success: false, error: 'انتهت مهلة الانتظار', logs: pubgets[pubgetId].logs };
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
