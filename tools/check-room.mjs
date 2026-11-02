#!/usr/bin/env node
// 联机房间规则自检：node tools/check-room.mjs
import assert from 'assert';
import { createRequire } from 'module';
import { createRoom, apply, snapshot, permissions } from '../worker/room-logic.mjs';

const require = createRequire(import.meta.url);
require('../data/champions.js');
const D = globalThis.WRBP.draft;
const NAMES = new Map(globalThis.WRBP_DATA.champions.map(c => [c.slug, c.name]));
const CTX = { isChampion: slug => NAMES.has(slug), name: slug => NAMES.get(slug) || slug };
const POOL = [...NAMES.keys()];

let passed = 0;
function test(name, run) {
    try {
        run();
        passed += 1;
    } catch (error) {
        console.error(`✗ ${name}\n  ${error.stack.split('\n').slice(0, 3).join('\n  ')}`);
        process.exitCode = 1;
    }
}
const throws = (run, pattern) => assert.throws(run, error => pattern.test(error.message) || assert.fail(`错误信息不对：${error.message}`));

let clock = 1000;
const room = (mode = 'duo', fearless = 'global', bestOf = 3) =>
    createRoom({ id: 'test01', mode, teams: { a: 'TT', b: 'FP' }, bestOf, fearless }, clock);
const run = (r, role, command) => apply(r, role, command, CTX, ++clock);
const turn = r => D.currentTurn(r.series);
const coachOnTurn = r => D.teamOn(r.series, turn(r).side);

// 按流程让两队教练轮流锁定，英雄从 POOL 里取第一个能用的。
function playDraft(r) {
    for (let t = turn(r); t; t = turn(r)) {
        const slug = POOL.find(s => !D.blockedReason(r.series, t, s));
        run(r, coachOnTurn(r), { type: 'lock', slug, turn: t.n });
    }
}

test('建房：参数不对拒绝；队名截断到 16 个字', () => {
    throws(() => createRoom({ mode: 'solo', bestOf: 3, fearless: 'off' }, 0), /双端或三端/);
    throws(() => createRoom({ mode: 'duo', bestOf: 2, fearless: 'off' }, 0), /BO1/);
    throws(() => createRoom({ mode: 'duo', bestOf: 3, fearless: 'x' }, 0), /全局 BP/);
    const r = createRoom({ mode: 'trio', bestOf: 5, fearless: 'team', teams: { a: '  ', b: 'x'.repeat(30) } }, 0);
    assert.strictEqual(r.series.teams.a.name, '队伍 A');
    assert.strictEqual(r.series.teams.b.name.length, 16);
});

test('只有轮到的一方能预选、锁定；观战和裁判不走这条路', () => {
    const r = room();
    assert.strictEqual(coachOnTurn(r), 'a');
    throws(() => run(r, 'b', { type: 'hover', slug: 'ahri', turn: 0 }), /还没轮到你，现在是 TT 禁用/);
    throws(() => run(r, 'view', { type: 'hover', slug: 'ahri' }), /观战不能操作/);
    throws(() => run(r, 'ref', { type: 'lock', slug: 'ahri' }), /裁判直接点/);
    throws(() => run(r, 'a', { type: 'hover', slug: 'not-a-champion' }), /没有这个英雄/);
    assert.ok(run(r, 'a', { type: 'hover', slug: 'ahri', turn: 0 }));
    assert.deepStrictEqual(r.hover, { turn: 0, slug: 'ahri' });
    assert.ok(!run(r, 'a', { type: 'hover', slug: 'ahri', turn: 0 }), '重复预选不算变化');
    run(r, 'a', { type: 'lock', turn: 0 });                                    // 不带 slug 就锁预选的
    assert.strictEqual(r.series.game.bans.blue[0], 'ahri');
    assert.strictEqual(r.hover, null);
    assert.strictEqual(r.last, 'TT 禁用 阿狸');
    throws(() => run(r, 'b', { type: 'lock', turn: 1 }), /先点一个英雄/);
});

test('过期的点击（页面还停在上一手）不生效；本局用过的英雄不能预选', () => {
    const r = room();
    run(r, 'a', { type: 'lock', slug: 'ahri', turn: 0 });
    throws(() => run(r, 'b', { type: 'lock', slug: 'zed', turn: 0 }), /往下走了/);
    throws(() => run(r, 'b', { type: 'hover', slug: 'ahri', turn: 1 }), /本局蓝方已禁用/);
    run(r, 'b', { type: 'skip', turn: 1 });
    assert.strictEqual(r.series.game.bans.red[0], '');
    assert.strictEqual(turn(r).n, 2);
});

test('身份跟着队伍走：换边后 a 在红方，轮到红方时是 a', () => {
    const r = room('duo', 'off');
    playDraft(r);
    run(r, 'b', { type: 'finish', winner: 'a' });                             // b 认输，直接生效
    assert.deepStrictEqual(r.series.score, { a: 1, b: 0 });
    assert.strictEqual(D.sideOf(r.series, 'a'), 'red');                        // 败方 b 在蓝方
    throws(() => run(r, 'a', { type: 'lock', slug: 'zed', turn: 0 }), /还没轮到你/);
    run(r, 'b', { type: 'lock', slug: 'zed', turn: 0 });
});

test('双端：要权限的操作发请求，对方同意才执行；自己不能同意自己', () => {
    const r = room();
    run(r, 'a', { type: 'lock', slug: 'ahri', turn: 0 });
    run(r, 'a', { type: 'undo' });
    assert.ok(r.proposal);
    assert.strictEqual(r.proposal.label, '撤销上一步（TT 禁用 阿狸）');
    assert.strictEqual(r.series.game.bans.blue[0], 'ahri', '还没同意，不执行');
    throws(() => run(r, 'a', { type: 'respond', id: r.proposal.id, accept: true }), /要由对方确认/);
    throws(() => run(r, 'b', { type: 'reset' }), /还在等对方确认/);
    run(r, 'b', { type: 'respond', id: r.proposal.id, accept: true });
    assert.strictEqual(r.series.game.bans.blue[0], null);
    assert.strictEqual(r.proposal, null);
    assert.strictEqual(r.last, '已撤销：TT 禁用 阿狸（FP 同意）');
});

test('双端：拒绝、撤回；BP 往下走了请求自动作废；做不了的请求发不出去', () => {
    const r = room();
    throws(() => run(r, 'a', { type: 'undo' }), /没有可以撤销/);
    throws(() => run(r, 'a', { type: 'reset' }), /本局还没开始/);
    run(r, 'a', { type: 'lock', slug: 'ahri', turn: 0 });
    run(r, 'b', { type: 'reset' });
    run(r, 'a', { type: 'respond', id: r.proposal.id, accept: false });
    assert.strictEqual(r.proposal, null);
    assert.strictEqual(r.last, 'TT 拒绝了：重开本局（清空本局 BP）');
    run(r, 'b', { type: 'settings', bestOf: 5 });
    const id = r.proposal.id;
    throws(() => run(r, 'a', { type: 'cancel', id }), /只能撤回自己/);
    run(r, 'b', { type: 'lock', slug: 'zed', turn: 1 });                       // 情况变了
    assert.strictEqual(r.proposal, null);
    throws(() => run(r, 'a', { type: 'respond', id, accept: true }), /已经失效/);
    assert.strictEqual(r.series.bestOf, 3);
});

test('记胜负：认输直接生效，记自己胜要对方同意；BP 没完成不能记', () => {
    const r = room();
    throws(() => run(r, 'a', { type: 'finish', winner: 'b' }), /BP 还没完成/);
    playDraft(r);
    run(r, 'a', { type: 'finish', winner: 'a' });
    assert.strictEqual(r.proposal.label, '记录本局 TT 胜');
    run(r, 'b', { type: 'respond', id: r.proposal.id, accept: true });
    assert.deepStrictEqual(r.series.score, { a: 1, b: 0 });
    assert.strictEqual(r.last, '第 1 局 TT 胜（FP 同意）');
});

test('败方选边：上一局输的一方在本局开始前直接换边，赢的一方要请求', () => {
    const r = room();
    playDraft(r);
    run(r, 'b', { type: 'finish', winner: 'a' });
    const p = permissions(r, 'b');
    assert.strictEqual(p.swap, 'direct');
    assert.strictEqual(permissions(r, 'a').swap, 'propose');
    run(r, 'b', { type: 'swap' });
    assert.strictEqual(D.sideOf(r.series, 'b'), 'red');
    run(r, coachOnTurn(r), { type: 'lock', slug: POOL[60], turn: 0 });
    assert.strictEqual(permissions(r, 'b').swap, null, '开始 BP 之后谁都不能换边');
    throws(() => run(r, 'b', { type: 'swap' }), /重开本局后才能换边/);
    assert.strictEqual(r.proposal, null, '做不了的请求发不出去');
});

test('三端：教练只管 BP，其余由裁判；裁判能改任意一格、直接撤销', () => {
    const r = room('trio');
    throws(() => run(r, 'a', { type: 'undo' }), /由裁判操作/);
    throws(() => run(r, 'a', { type: 'fill', ref: { side: 'blue', type: 'ban', index: 0 }, value: 'ahri' }), /只有裁判/);
    assert.deepStrictEqual(permissions(r, 'a'), {
        undo: null, finish: { a: null, b: null }, swap: null, settings: null, reset: null, newSeries: null,
    });
    assert.deepStrictEqual(permissions(r, 'ref'), {
        undo: null, finish: { a: null, b: null }, swap: 'direct', settings: 'direct', reset: null, newSeries: 'direct',
    });
    run(r, 'ref', { type: 'fill', ref: { side: 'red', type: 'pick', index: 2 }, value: 'zed' });
    assert.strictEqual(r.last, '裁判：FP 3 楼 劫');
    throws(() => run(r, 'ref', { type: 'fill', ref: { side: 'red', type: 'pick', index: 9 }, value: 'zed' }), /没有这一格/);
    throws(() => run(r, 'ref', { type: 'fill', ref: { side: 'blue', type: 'pick', index: 0 }, value: 'zed' }), /本局红方已选用/);
    run(r, 'ref', { type: 'undo' });
    assert.strictEqual(r.series.game.picks.red[2], null);
    run(r, 'ref', { type: 'fill', ref: { side: 'blue', type: 'ban', index: 0 }, value: '' });
    assert.strictEqual(r.series.game.bans.blue[0], '');
    run(r, 'ref', { type: 'fill', ref: { side: 'blue', type: 'ban', index: 0 }, value: null });
    assert.strictEqual(r.series.game.bans.blue[0], null);
    playDraft(r);
    assert.deepStrictEqual(permissions(r, 'a').finish, { a: null, b: 'direct' }, '三端教练只能认输');
    run(r, 'ref', { type: 'finish', winner: 'b' });
    run(r, 'ref', { type: 'settings', fearless: 'off', bestOf: 5 });
    assert.deepStrictEqual([r.series.bestOf, r.series.fearless], [5, 'off']);
});

test('全局 BP 在联机里照样生效；撤销不会把改过的队名改回去', () => {
    const r = room('trio', 'global');
    playDraft(r);
    const used = r.series.game.picks.blue[0];
    run(r, 'ref', { type: 'finish', winner: 'a' });
    throws(() => run(r, coachOnTurn(r), { type: 'hover', slug: used, turn: 0 }), /全局 BP：TT 在第 1 局已选用/);
    run(r, 'a', { type: 'rename', team: 'a', name: 'Team Tes' });
    throws(() => run(r, 'a', { type: 'rename', team: 'b', name: 'x' }), /只能改自己/);
    run(r, 'ref', { type: 'undo' });
    assert.deepStrictEqual(r.series.score, { a: 0, b: 0 });
    assert.strictEqual(r.series.teams.a.name, 'Team Tes');
});

test('快照不带撤销历史；未知命令拒绝', () => {
    const r = room();
    run(r, 'a', { type: 'lock', slug: 'ahri', turn: 0 });
    const view = snapshot(r);
    assert.strictEqual(view.undo, undefined);
    assert.strictEqual(view.undoLabel, 'TT 禁用 阿狸');
    throws(() => run(r, 'a', { type: 'hack' }), /未知的操作/);
    throws(() => run(r, 'a', { type: 'constructor' }), /未知的操作/);
    throws(() => run(r, 'god', { type: 'hover', slug: 'zed' }), /身份不对/);
});

console.log(`${passed} 条通过${process.exitCode ? '，有失败' : ''}`);
