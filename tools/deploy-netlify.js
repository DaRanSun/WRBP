#!/usr/bin/env node
// 发布到 Netlify：node tools/deploy-netlify.js [站点名]
//
// 和 WRPedia 录入后台的“发布公网”同一套做法，不需要装 Netlify CLI：
// 凭据取环境变量 NETLIFY_AUTH_TOKEN，或者 Netlify CLI 登录过留下的 token；
// 站点取环境变量 NETLIFY_SITE_ID，或者 .netlify/state.json。都没有就新建一个站点（默认名 wrbp → wrbp.netlify.app），
// 并把站点 ID 写进 .netlify/state.json，以后发布都更新同一个站点。
// 只上传 Netlify 上还没有的文件（按 SHA1 比），英雄图没变时几秒就发完。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const API = (process.env.NETLIFY_API_URL || 'https://api.netlify.com/api/v1').replace(/\/$/, '');
const STATE = path.join(ROOT, '.netlify', 'state.json');
const { STATIC, files } = require('./build');       // 发布哪些文件在 build.js 里定（Netlify 只发单机版）
const TIMEOUT_MS = 180000;

function token() {
    if (process.env.NETLIFY_AUTH_TOKEN) return process.env.NETLIFY_AUTH_TOKEN;
    const home = os.homedir();
    const candidates = [
        path.join(home, 'Library', 'Preferences', 'netlify', 'config.json'),
        path.join(process.env.APPDATA || home, 'netlify', 'Config', 'config.json'),
        path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'netlify', 'config.json'),
    ];
    for (const file of candidates) {
        try {
            const config = JSON.parse(fs.readFileSync(file, 'utf8'));
            const user = (config.users || {})[config.userId] || {};
            if (user.auth && user.auth.token) return user.auth.token;
        } catch (error) { /* 下一个 */ }
    }
    throw new Error('找不到 Netlify 登录：请先运行一次 netlify login，或设置环境变量 NETLIFY_AUTH_TOKEN');
}

async function netlify(method, route, auth, { json, body } = {}) {
    const headers = { Authorization: `Bearer ${auth}`, 'User-Agent': 'WRBP-deploy' };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    if (body !== undefined) headers['Content-Type'] = 'application/octet-stream';
    const response = await fetch(API + route, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
    const text = await response.text();
    if (!response.ok) {
        const error = new Error(`${method} ${route} 失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
        error.status = response.status;
        throw error;
    }
    return text.trim() ? JSON.parse(text) : {};
}

async function site(auth, name) {
    let id = process.env.NETLIFY_SITE_ID;
    if (!id) {
        try { id = JSON.parse(fs.readFileSync(STATE, 'utf8')).siteId; } catch (error) { id = null; }
    }
    if (id) return netlify('GET', `/sites/${id}`, auth);
    console.log(`新建 Netlify 站点 ${name} …`);
    let created;
    try {
        created = await netlify('POST', '/sites', auth, { json: { name } });
    } catch (error) {
        if (error.status === 422) throw new Error(`站点名 ${name} 已被占用，换一个：node tools/deploy-netlify.js 别的名字`);
        throw error;
    }
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ siteId: created.id }, null, '\t') + '\n');
    return created;
}

async function main() {
    const auth = token();
    const info = await site(auth, process.argv[2] || 'wrbp');
    const local = files(STATIC);
    const digests = {};
    for (const [route, file] of Object.entries(local)) {
        digests[route] = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    }
    const version = (fs.readFileSync(path.join(ROOT, 'data', 'champions.js'), 'utf8').match(/WRPedia V([\d.]+)/) || [])[1];
    const title = `WRBP ${new Date().toISOString().slice(0, 10)}${version ? `（英雄池 WRPedia V${version}）` : ''}`;
    console.log(`${info.name}：${Object.keys(local).length} 个文件，创建部署…`);
    let deploy = await netlify('POST', `/sites/${info.id}/deploys`, auth, { json: { files: digests, draft: false, title } });

    // 只传 Netlify 要的（同样内容的文件只传一次），8 个并行。
    const required = new Set(deploy.required || []);
    const queue = Object.entries(digests).filter(([, digest]) => {
        if (!required.has(digest)) return false;
        required.delete(digest);
        return true;
    });
    let sent = 0;
    const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
            const [route] = item;
            const encoded = route.slice(1).split('/').map(encodeURIComponent).join('/');
            await netlify('PUT', `/deploys/${deploy.id}/files/${encoded}`, auth, { body: fs.readFileSync(local[route]) });
            sent += 1;
        }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    console.log(`已上传 ${sent} 个文件，等待上线…`);

    const started = Date.now();
    while (!['ready', 'error'].includes(deploy.state) && Date.now() - started < TIMEOUT_MS) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        deploy = await netlify('GET', `/deploys/${deploy.id}`, auth);
    }
    if (deploy.state !== 'ready') throw new Error(`部署没有完成：${deploy.state}${deploy.error_message ? '，' + deploy.error_message : ''}`);
    const url = info.ssl_url || info.url;
    console.log(`已上线：${url}`);
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
