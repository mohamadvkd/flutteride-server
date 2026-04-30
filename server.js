const express = require('express');
const multer = require('multer');
const axios = require('axios');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const app = express();
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

// ============================================================
// استقبال ZIP وبدء البناء
// ============================================================
app.post('/build', upload.single('file'), async (req, res) => {
    try {
        const zipFile = req.file;
        
        if (!zipFile) {
            return res.status(400).json({ status: 'error', message: 'لم يتم إرسال ملف' });
        }

        // إنشاء build_id فريد
        const buildId = Date.now().toString();
        
        // حفظ حالة البناء
        builds[buildId] = {
            status: 'uploading',
            downloadUrl: null,
            error: null,
            logs: '',
            started: new Date()
        };

        // الرد فوراً بـ build_id
        res.json({ status: 'building', build_id: buildId });

        // متابعة البناء في الخلفية
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
    
    // تنظيف البناءات القديمة (أكثر من 30 دقيقة)
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
    try {
        builds[buildId].status = 'extracting';
        builds[buildId].logs += '📦 بدء عملية البناء\n';
        console.log(`[${buildId}] بدء عملية البناء`);

        // 1. فك ضغط ZIP
        builds[buildId].logs += '📂 فك ضغط المشروع...\n';
        console.log(`[${buildId}] فك ضغط الملف...`);
        const zip = new AdmZip(zipFile.path);
        const projectDir = path.join(__dirname, 'temp', buildId);
        zip.extractAllTo(projectDir, true);
        builds[buildId].logs += '✓ تم فك ضغط المشروع\n';

        // 2. رفع الملفات إلى GitHub
        builds[buildId].status = 'uploading_to_github';
        builds[buildId].logs += '📤 رفع الملفات إلى GitHub...\n';
        console.log(`[${buildId}] رفع الملفات إلى GitHub...`);
        await uploadToGitHub(projectDir, buildId);
        builds[buildId].logs += '✓ تم رفع الملفات بنجاح\n';
        console.log(`[${buildId}] تم رفع الملفات بنجاح`);

        // 3. انتظار البناء
        builds[buildId].status = 'building';
        builds[buildId].logs += '⏳ انتظار اكتمال البناء من GitHub Actions...\n';
        console.log(`[${buildId}] انتظار GitHub Actions...`);
        const result = await waitForBuild(buildId);

        // 4. تنظيف
        try {
            fs.rmSync(zipFile.path);
            fs.rmSync(projectDir, { recursive: true, force: true });
        } catch (e) {}

        if (result.success) {
            builds[buildId].status = 'success';
            builds[buildId].downloadUrl = result.downloadUrl;
            builds[buildId].logs += '✅ تم البناء بنجاح!\n';
            builds[buildId].logs += `📥 رابط التنزيل: ${result.downloadUrl}\n`;
            console.log(`[${buildId}] تم البناء بنجاح!`);
        } else {
            builds[buildId].status = 'error';
            builds[buildId].error = result.error;
            builds[buildId].logs += result.logs || '❌ فشل البناء على GitHub Actions\n';
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
// دالة رفع الملفات إلى GitHub
// ============================================================
async function uploadToGitHub(projectDir, buildId) {
    const apiBase = `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}`;
    const headers = {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'FlutterIDE-Server'
    };

    // 1. Get latest commit
    builds[buildId].logs += '📡 جلب آخر commit من GitHub...\n';
    const branchRes = await axios.get(`${apiBase}/branches/${GITHUB_BRANCH}`, { headers });
    const latestSha = branchRes.data.commit.sha;
    const treeSha = branchRes.data.commit.commit.tree.sha;

    // 2. Create blobs and tree
    const treeItems = [];
    await createTreeItems(projectDir, '', treeItems, headers, apiBase, buildId);

    // 3. Create tree
    builds[buildId].logs += '🌳 إنشاء شجرة الملفات...\n';
    const treeRes = await axios.post(`${apiBase}/git/trees`, {
        tree: treeItems,
        base_tree: treeSha
    }, { headers });

    // 4. Create commit
    builds[buildId].logs += '💾 إنشاء commit جديد...\n';
    const commitRes = await axios.post(`${apiBase}/git/commits`, {
        message: `Build from FlutterIDE - ${new Date().toISOString()}`,
        tree: treeRes.data.sha,
        parents: [latestSha]
    }, { headers });

    // 5. Update branch
    builds[buildId].logs += '🚀 دفع التغييرات إلى GitHub...\n';
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
            
            // Create blob
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
// انتظار بناء GitHub Actions مع جلب السجلات التفصيلية
// ============================================================
async function waitForBuild(buildId) {
    const apiBase = `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}`;
    const headers = {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'FlutterIDE-Server'
    };

    // جلب آخر run قبل البناء
    const initialRuns = await axios.get(`${apiBase}/actions/runs?branch=${GITHUB_BRANCH}&per_page=1`, { headers });
    const lastRunBefore = initialRuns.data.workflow_runs[0]?.id || 0;
    
    builds[buildId].logs += `🔍 آخر run موجود قبل البناء: ${lastRunBefore}\n`;
    console.log(`[${buildId}] آخر run موجود قبل البناء: ${lastRunBefore}`);

    for (let i = 0; i < 120; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const elapsed = (i + 1) * 5;
        if (elapsed % 30 === 0) {
            builds[buildId].logs += `⏳ انتظار البناء... (${elapsed} ثانية)\n`;
            console.log(`[${buildId}] انتظار البناء... (${elapsed} ثانية)`);
        }

        const runsRes = await axios.get(`${apiBase}/actions/runs?branch=${GITHUB_BRANCH}&per_page=5`, { headers });
        
        for (const run of runsRes.data.workflow_runs) {
            if (run.id <= lastRunBefore && run.status === 'completed') {
                continue;
            }
            
            builds[buildId].logs += `📊 Run #${run.id}: ${run.status} (${run.conclusion || 'pending'})\n`;
            console.log(`[${buildId}] Run #${run.id}: ${run.status} (${run.conclusion || 'pending'})`);
            
            if (run.status === 'completed') {
                if (run.conclusion === 'success') {
                    builds[buildId].logs += `✅ اكتمل البناء بنجاح!\n`;
                    console.log(`[${buildId}] اكتمل البناء بنجاح!`);
                    
                    const releasesRes = await axios.get(`${apiBase}/releases?per_page=1`, { headers });
                    if (releasesRes.data.length > 0 && releasesRes.data[0].assets.length > 0) {
                        const downloadUrl = releasesRes.data[0].assets[0].browser_download_url;
                        return { success: true, downloadUrl: downloadUrl };
                    }
                    return { success: false, error: 'لم يتم العثور على ملف APK', logs: builds[buildId].logs };
                } else {
                    builds[buildId].logs += `❌ فشل البناء (${run.conclusion})\n`;
                    console.log(`[${buildId}] فشل البناء (${run.conclusion})`);
                    
                    // جلب سجلات البناء التفصيلية من GitHub Actions
                    builds[buildId].logs += `📥 جلب سجلات البناء التفصيلية من GitHub...\n`;
                    
                    try {
                        // 1. جلب سجلات الـ run الخام (تحتوي على أخطاء Flutter/Gradle)
                        const logsUrl = `${apiBase}/actions/runs/${run.id}/logs`;
                        const logsRes = await axios.get(logsUrl, { 
                            headers, 
                            responseType: 'text' 
                        });
                        
                        if (logsRes.data && logsRes.data.length > 0) {
                            builds[buildId].logs += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
                            builds[buildId].logs += `📄 سجلات البناء التفصيلية (Flutter/Gradle):\n`;
                            builds[buildId].logs += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
                            
                            // تجميع السجلات وعرض آخر 200 سطر فقط لتجنب الحجم الكبير
                            const logLines = logsRes.data.split('\n');
                            const relevantLines = [];
                            
                            // البحث عن الأسطر التي تحتوي على أخطاء
                            for (const line of logLines) {
                                if (line.includes('error:') || 
                                    line.includes('Error:') || 
                                    line.includes('ERROR:') ||
                                    line.includes('FAILURE:') ||
                                    line.includes('Exception:') ||
                                    line.includes('Could not find') ||
                                    line.includes('undefined') ||
                                    line.includes('syntax error') ||
                                    line.includes('Build failed')) {
                                    relevantLines.push(line);
                                }
                            }
                            
                            // إذا وجدت أخطاء محددة، اعرضها أولاً
                            if (relevantLines.length > 0) {
                                builds[buildId].logs += `\n⚠️ الأخطاء المكتشفة:\n`;
                                for (const line of relevantLines.slice(-30)) {
                                    builds[buildId].logs += `  ❌ ${line}\n`;
                                }
                            }
                            
                            // عرض آخر 100 سطر من السجلات الكاملة
                            builds[buildId].logs += `\n📋 آخر 100 سطر من سجلات البناء:\n`;
                            const lastLines = logLines.slice(-100);
                            for (const line of lastLines) {
                                if (line.trim().length > 0) {
                                    builds[buildId].logs += `${line}\n`;
                                }
                            }
                            builds[buildId].logs += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
                        } else {
                            builds[buildId].logs += `⚠️ لا توجد سجلات تفصيلية متاحة\n`;
                        }
                        
                    } catch (logErr) {
                        builds[buildId].logs += `⚠️ فشل في جلب السجلات التفصيلية: ${logErr.message}\n`;
                    }
                    
                    return { 
                        success: false, 
                        error: `فشل البناء: ${run.conclusion}`, 
                        logs: builds[buildId].logs 
                    };
                }
            }
        }
    }
    
    builds[buildId].logs += `⏰ انتهت مهلة الانتظار (10 دقائق)\n`;
    return { 
        success: false, 
        error: 'انتهت مهلة الانتظار', 
        logs: builds[buildId].logs 
    };
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
