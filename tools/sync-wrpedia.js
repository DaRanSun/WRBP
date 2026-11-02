#!/usr/bin/env node
// 从 WRPedia 同步英雄池：英雄资料、国服名与昵称、头像和立绘、WRL 选禁次数与常用分路。
// 生成 data/champions.js，图片复制进 assets/champions/，WRBP 不依赖 WRPedia 也能单独打开、发布。
//
//   node tools/sync-wrpedia.js              默认读 ../WRPedia
//   node tools/sync-wrpedia.js 路径/WRPedia
//
// WRPedia 加了新英雄、改了昵称或录入了新比赛后重跑一次即可。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.resolve(process.argv[2] || path.join(ROOT, '..', 'WRPedia'));
const IMAGES = path.join(ROOT, 'assets', 'champions');
const OUTPUT = path.join(ROOT, 'data', 'champions.js');
const ROLES = ['top', 'jungle', 'mid', 'bot', 'support'];

// 个别英雄的图片处理，和 WROB 的 config/art.yaml 一致。
// iconFocus / iconZoom：没有方形小图时用立绘裁；portraitFocus：横版原画裁成竖的。
const ART = {
    hwei: { portraitFocus: '58% 18%' },
    norra: { iconFocus: '40% 46%', iconZoom: 1.7 },
};

// 读 WRPedia 的 "window.X = …;" 数据文件。
function readWindow(file, name) {
    const context = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(SOURCE, file), 'utf8'), context, { filename: file });
    if (!context.window[name]) throw new Error(`${file} 里没有 window.${name}`);
    return context.window[name];
}

// WRL 已录入小局里每个英雄的选用、禁用次数，以及各分路的出场占比。
function leagueStats(league) {
    const stats = {};
    const entry = slug => (stats[slug] = stats[slug] || { picks: 0, bans: 0, roles: {} });
    for (const round of league.rounds || []) {
        for (const match of round.matches || []) {
            for (const game of match.games || []) {
                for (const key of ['team1', 'team2']) {
                    const side = game[key] || {};
                    (side.picks || []).forEach((slug, index) => {
                        if (!slug) return;
                        const item = entry(slug);
                        item.picks += 1;
                        // 旧记录没有 pickRoles，picks 本身就是上野中下辅顺序。
                        const role = Array.isArray(side.pickRoles) ? side.pickRoles[index] : ROLES[index];
                        const roles = (Array.isArray(role) ? role : [role]).filter(r => ROLES.includes(r));
                        roles.forEach(r => { item.roles[r] = (item.roles[r] || 0) + 1 / roles.length; });
                    });
                    (side.bans || []).forEach(slug => { if (slug) entry(slug).bans += 1; });
                }
            }
        }
    }
    for (const item of Object.values(stats)) {
        const total = Object.values(item.roles).reduce((sum, value) => sum + value, 0);
        for (const role of Object.keys(item.roles)) item.roles[role] = Math.round(item.roles[role] / total * 100) / 100;
    }
    return stats;
}

function main() {
    if (!fs.existsSync(path.join(SOURCE, 'data', 'champions.json'))) {
        throw new Error(`找不到 WRPedia：${SOURCE}`);
    }
    const base = JSON.parse(fs.readFileSync(path.join(SOURCE, 'data', 'champions.json'), 'utf8'));
    const locales = readWindow('data/champion-locales.js', 'WR_CHAMPION_LOCALES');
    const stats = leagueStats(readWindow('data/schedule.js', 'WR_LEAGUE'));
    const site = readWindow('data/site.js', 'WR_SITE');
    const folder = path.join(SOURCE, 'assets', 'champions');

    fs.mkdirSync(IMAGES, { recursive: true });
    const keep = new Set();
    const copy = name => {
        fs.copyFileSync(path.join(folder, name), path.join(IMAGES, name));
        keep.add(name);
        return `assets/champions/${name}`;
    };

    const champions = base.map(entry => {
        const slug = entry.slug;
        const locale = locales[slug] || {};
        const art = Object.assign({}, ART[slug]);
        const portrait = fs.existsSync(path.join(folder, `${slug}-portrait.jpg`)) ? copy(`${slug}-portrait.jpg`) : null;
        let icon;
        if (fs.existsSync(path.join(folder, `${slug}.png`)) && !art.iconFocus) icon = copy(`${slug}.png`);
        else if (portrait) { icon = portrait; art.iconFocus = art.iconFocus || '50% 30%'; }
        else throw new Error(`${slug} 没有头像也没有立绘`);
        const league = stats[slug] || { picks: 0, bans: 0, roles: {} };
        const champion = {
            slug,
            name: locale.name || entry.nameZh || entry.name,     // 国服中文名
            title: locale.title || '',
            en: entry.name,
            tw: entry.nameZh && entry.nameZh !== locale.name ? entry.nameZh : '',
            aliases: locale.aliases || [],
            icon,
            portrait: portrait || icon,
            picks: league.picks,
            bans: league.bans,
            roles: league.roles,
        };
        if (Object.keys(art).length) champion.art = art;
        return champion;
    });

    // 清掉 WRPedia 里已经没有的旧图。
    for (const name of fs.readdirSync(IMAGES)) {
        if (!keep.has(name)) fs.unlinkSync(path.join(IMAGES, name));
    }

    const data = {
        source: { name: 'WRPedia', version: site.version, syncedAt: new Date().toISOString().slice(0, 10) },
        champions,
    };
    const header = '// 自动生成，不要手改：node tools/sync-wrpedia.js\n'
        + `// 英雄池来自 WRPedia V${site.version}，共 ${champions.length} 名英雄。\n`;
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    // 浏览器里挂在 window 上；联机版的 Worker 和 Node 自检里挂在 globalThis 上（Worker 用它校验英雄、写操作记录）。
    fs.writeFileSync(OUTPUT, `${header}(typeof window !== 'undefined' ? window : globalThis).WRBP_DATA = ${JSON.stringify(data, null, 1)};\n`);

    const played = champions.filter(c => c.picks || c.bans).length;
    console.log(`已同步 ${champions.length} 名英雄（WRPedia V${site.version}），${keep.size} 张图片；WRL 出现过 ${played} 名。`);
}

main();
