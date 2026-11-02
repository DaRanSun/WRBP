// 英雄池：查找、检索、出图。数据来自 data/champions.js（tools/sync-wrpedia.js 从 WRPedia 生成）。
(function (root) {
    'use strict';

    const DATA = root.WRBP_DATA || { source: {}, champions: [] };
    const ROLE_NAMES = { top: '上单', jungle: '打野', mid: '中路', bot: '下路', support: '辅助' };

    // 检索时忽略大小写、全半角、空格、连字符和间隔号，和 WRPedia 的习惯一致。
    function normalize(text) {
        return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\-'’‘·.]/g, '');
    }

    const collator = new Intl.Collator('zh-Hans-CN');
    const byName = DATA.champions.slice().sort((a, b) => collator.compare(a.name, b.name));
    // 按 WRL 选禁次数排，常用的在前；次数相同的仍按名称（稳定排序）。
    const byUsage = byName.slice().sort((a, b) => (b.picks + b.bans) - (a.picks + a.bans));
    const bySlug = new Map();
    byName.forEach(champion => {
        // 国服名、称号、英文名、WRPedia 的繁中原名、slug，加上 WRPedia 收录的拼音、首字母和昵称。
        champion.keys = [champion.name, champion.title, champion.en, champion.tw, champion.slug]
            .concat(champion.aliases || []).map(normalize).filter(Boolean);
        bySlug.set(champion.slug, champion);
    });

    // 完全匹配排最前（昵称优先，打“剑魔”就是亚托克斯），其次是开头匹配，再其次是包含；同一档里保持 source 原来的顺序。
    function search(query, source) {
        const needle = normalize(query);
        source = source || byName;
        if (!needle) return source.slice();
        const ranked = [];
        source.forEach((champion, order) => {
            let rank = 3;
            for (const key of champion.keys) {
                if (key === needle) { rank = 0; break; }
                if (key.startsWith(needle)) rank = Math.min(rank, 1);
                else if (rank > 2 && key.includes(needle)) rank = 2;
            }
            if (rank < 3) ranked.push([rank, order, champion]);
        });
        return ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(item => item[2]);
    }

    function image(src, focus, zoom) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.draggable = false;
        img.decoding = 'async';
        if (focus) img.style.objectPosition = focus;
        if (zoom) {
            img.style.transform = `scale(${zoom})`;
            img.style.transformOrigin = focus || '50% 50%';
        }
        return img;
    }

    // 方形小图。没有小图的英雄（诺拉）用立绘按焦点裁。
    function icon(slug, lazy) {
        const champion = bySlug.get(slug);
        if (!champion) return document.createElement('span');
        const art = champion.art || {};
        const img = image(champion.icon, art.iconFocus, art.iconZoom);
        if (lazy) img.loading = 'lazy';
        return img;
    }

    // 竖版立绘。横版原画（彗）按焦点裁。
    function portrait(slug) {
        const champion = bySlug.get(slug);
        if (!champion) return document.createElement('span');
        return image(champion.portrait, (champion.art || {}).portraitFocus || '50% 18%');
    }

    function name(slug) {
        return bySlug.has(slug) ? bySlug.get(slug).name : slug;
    }

    // 悬停提示：名字、称号、WRL 选禁次数和常用分路。
    function describe(slug) {
        const c = bySlug.get(slug);
        if (!c) return slug;
        const lines = [`${c.name} · ${c.title}`.replace(/ · $/, ''), c.en];
        if (c.picks || c.bans) {
            const roles = Object.entries(c.roles || {}).sort((a, b) => b[1] - a[1])
                .filter(([, share]) => share >= 0.2).map(([role]) => ROLE_NAMES[role]).join(' / ');
            lines.push(`WRL：选用 ${c.picks} · 禁用 ${c.bans}${roles ? ' · ' + roles : ''}`);
        }
        return lines.join('\n');
    }

    root.WRBP = root.WRBP || {};
    root.WRBP.champions = {
        source: DATA.source,
        list: byName,
        byUsage,
        get: slug => bySlug.get(slug) || null,
        search,
        normalize,
        icon,
        portrait,
        name,
        describe,
    };
})(window);
