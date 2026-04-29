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
// استقبال ZIP وبناء APK
// ============================================================
app.post('/build', upload.single('file'), async (req, res) => {
    try {
        const zipFile = req.file;
        
        if (!zipFile) {
            return res.status(400).json({ status: 'error', message: 'لم يتم إرسال ملف' });
        }

        console.log('=============================');
        console.log('بدء عملية بناء جديدة');
        console.log('=============================');

        // 1. فك ضغط ZIP
        console.log('فك ضغط الملف...');
        const zip = new AdmZip(zipFile.path);
        const projectDir = path.join(__dirname, 'temp', Date.now().toString());
        zip.extractAllTo(projectDir, true);

        // 2. رفع الملفات إلى GitHub
        console.log('رفع الملفات إلى GitHub...');
        await uploadToGitHub(projectDir);
        console.log('تم رفع الملفات بنجاح');

        // 3. انتظار البناء
        console.log('انتظار GitHub Actions...');
        const downloadUrl = await waitForBuild();

        // 4. تنظيف
        fs.rmSync(zipFile.path);
        fs.rmSync(projectDir, { recursive: true, force: true });

        if (downloadUrl) {
            console.log('تم البناء بنجاح!');
            res.json({ status: 'success', download_url: downloadUrl });
        } else {
            console.log('فشل البناء');
            res.json({ status: 'error', message: 'فشل البناء على GitHub Actions' });
        }

    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ============================================================
// دالة رفع الملفات إلى GitHub
// ============================================================
async function uploadToGitHub(projectDir) {
    const apiBase = `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}`;
    const headers = {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'FlutterIDE-Server'
    };

    // 1. Get latest commit
    const branchRes = await axios.get(`${apiBase}/branches/${GITHUB_BRANCH}`, { headers });
    const latestSha = branchRes.data.commit.sha;
    const treeSha = branchRes.data.commit.commit.tree.sha;

    // 2. Create blobs and tree
    const treeItems = [];
    await createTreeItems(projectDir, '', treeItems, headers, apiBase);

    // 3. Create tree
    const treeRes = await axios.post(`${apiBase}/git/trees`, {
        tree: treeItems,
        base_tree: treeSha
    }, { headers });

    // 4. Create commit
    const commitRes = await axios.post(`${apiBase}/git/commits`, {
        message: `Build from FlutterIDE - ${new Date().toISOString()}`,
        tree: treeRes.data.sha,
        parents: [latestSha]
    }, { headers });

    // 5. Update branch
    await axios.patch(`${apiBase}/git/refs/heads/${GITHUB_BRANCH}`, {
        sha: commitRes.data.sha
    }, { headers });
}

async function createTreeItems(dirPath, basePath, treeItems, headers, apiBase) {
    const items = fs.readdirSync(dirPath);
    
    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const relativePath = basePath ? `${basePath}/${item}` : item;
        
        if (fs.statSync(fullPath).isDirectory()) {
            await createTreeItems(fullPath, relativePath, treeItems, headers, apiBase);
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
// انتظار بناء GitHub Actions (مع تجاهل runs القديمة)
// ============================================================
async function waitForBuild() {
    const apiBase = `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}`;
    const headers = {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'FlutterIDE-Server'
    };

    // حفظ آخر run موجود قبل البناء الجديد
    const initialRuns = await axios.get(`${apiBase}/actions/runs?branch=${GITHUB_BRANCH}&per_page=1`, { headers });
    const lastRunBefore = initialRuns.data.workflow_runs[0]?.id || 0;
    
    console.log(`آخر run موجود قبل البناء: ${lastRunBefore}`);

    for (let i = 0; i < 90; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const elapsed = (i + 1) * 5;
        if (elapsed % 30 === 0) {
            console.log(`انتظار البناء... (${elapsed} ثانية)`);
        }

        const runsRes = await axios.get(`${apiBase}/actions/runs?branch=${GITHUB_BRANCH}&per_page=5`, { headers });
        
        for (const run of runsRes.data.workflow_runs) {
            // تجاهل runs القديمة التي كانت موجودة قبل البناء
            if (run.id <= lastRunBefore && run.status === 'completed') {
                continue;
            }
            
            console.log(`Run #${run.id}: ${run.status} (${run.conclusion || 'pending'})`);
            
            if (run.status === 'completed') {
                if (run.conclusion === 'success') {
                    console.log('اكتمل البناء بنجاح!');
                    const releasesRes = await axios.get(`${apiBase}/releases?per_page=1`, { headers });
                    if (releasesRes.data.length > 0 && releasesRes.data[0].assets.length > 0) {
                        return releasesRes.data[0].assets[0].browser_download_url;
                    }
                } else {
                    console.log('فشل البناء');
                    return null;
                }
            }
        }
    }
    
    console.log('انتهت مهلة الانتظار');
    return null;
}

// ============================================================
// صفحة رئيسية للتأكد من عمل الخادم
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
