#!/usr/bin/env node
// 把要发布的页面复制到 dist/（Cloudflare 的静态资源目录）：node tools/build.js
// 发布哪些文件也在这里定，Netlify 的发布脚本（deploy-netlify.js）用同一份列表。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// 联机版（Cloudflare）：单机页、联机大厅、房间页和它们用到的全部资源。
const ONLINE = ['index.html', 'online.html', 'room.html', 'manifest.webmanifest', 'assets', 'data'];
// 单机版（Netlify）：没有联机服务，只发单机页（联机入口跳到 Cloudflare）。
const STATIC = ['index.html', 'manifest.webmanifest', 'assets', 'data'];

// { 发布路径: 本地文件 }，跳过 . 开头的文件。
function files(list) {
    const result = {};
    const walk = relative => {
        const absolute = path.join(ROOT, relative);
        if (fs.statSync(absolute).isDirectory()) {
            for (const name of fs.readdirSync(absolute).sort()) if (!name.startsWith('.')) walk(path.join(relative, name));
        } else {
            result['/' + relative.split(path.sep).join('/')] = absolute;
        }
    };
    list.forEach(walk);
    return result;
}

function build() {
    fs.rmSync(DIST, { recursive: true, force: true });
    const published = files(ONLINE);
    for (const [route, source] of Object.entries(published)) {
        const target = path.join(DIST, route);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
    }
    console.log(`dist/：${Object.keys(published).length} 个文件`);
}

module.exports = { ONLINE, STATIC, files };

if (require.main === module) build();
