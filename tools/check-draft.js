#!/usr/bin/env node
// BP 规则自检：node tools/check-draft.js
'use strict';

const assert = require('assert');
const path = require('path');
require(path.join(__dirname, '..', 'assets', 'js', 'draft.js'));
const D = globalThis.WRBP.draft;

let passed = 0;
function test(name, run) {
    try {
        run();
        passed += 1;
    } catch (error) {
        console.error(`✗ ${name}\n  ${error.message}`);
        process.exitCode = 1;
    }
}
const throws = (run, pattern) => assert.throws(run, error => pattern.test(error.message));

// 按流程把一局填满，英雄从 pool 里依次取。
function playDraft(state, pool) {
    let i = 0;
    for (let turn = D.currentTurn(state); turn; turn = D.currentTurn(state)) D.fill(state, turn, pool[i++]);
}
const pool = n => Array.from({ length: 20 }, (_, i) => `champ-${n}-${i}`);

test('竞技征召顺序和 WROB 赛事征召一致', () => {
    const order = D.TURNS.map(t => `${t.side === 'blue' ? 'B' : 'R'}${t.type === 'ban' ? '禁' : '选'}${t.index + 1}`);
    assert.deepStrictEqual(order, [
        'B禁1', 'R禁1', 'B禁2', 'R禁2', 'B禁3', 'R禁3',
        'B选1', 'R选1', 'R选2', 'B选2', 'B选3', 'R选3',
        'R禁4', 'B禁4', 'R禁5', 'B禁5',
        'R选4', 'B选4', 'B选5', 'R选5',
    ]);
    assert.deepStrictEqual(D.SLOT_COUNT, { ban: 5, pick: 5 });
});

test('当前手是第一个空格，跳着填、清掉都不乱', () => {
    const s = D.newSeries();
    assert.strictEqual(D.currentTurn(s).n, 0);
    D.fill(s, { side: 'red', type: 'ban', index: 0 }, 'ahri');      // 跳着填第 2 手
    assert.strictEqual(D.currentTurn(s).n, 0);
    D.fill(s, D.currentTurn(s), 'zed');
    assert.strictEqual(D.currentTurn(s).n, 2);
    D.clear(s, { side: 'blue', type: 'ban', index: 0 });
    assert.strictEqual(D.currentTurn(s).n, 0);
});

test('同一局禁用、选用过的英雄双方都不能再用', () => {
    const s = D.newSeries();
    D.fill(s, D.currentTurn(s), 'ahri');                                  // 蓝方禁阿狸
    throws(() => D.fill(s, D.currentTurn(s), 'ahri'), /本局蓝方已禁用/);
    throws(() => D.fill(s, { side: 'red', type: 'pick', index: 0 }, 'ahri'), /本局蓝方已禁用/);
    D.fill(s, { side: 'blue', type: 'pick', index: 0 }, 'zed');
    throws(() => D.fill(s, { side: 'red', type: 'pick', index: 0 }, 'zed'), /本局蓝方已选用/);
    // 改同一格时不算它自己
    D.fill(s, { side: 'blue', type: 'pick', index: 0 }, 'zed');
});

test('空 Ban 只能用在禁用位，可以有多个', () => {
    const s = D.newSeries();
    D.fill(s, D.currentTurn(s), D.EMPTY_BAN);
    D.fill(s, D.currentTurn(s), D.EMPTY_BAN);
    assert.strictEqual(D.currentTurn(s).n, 2);
    throws(() => D.fill(s, { side: 'blue', type: 'pick', index: 0 }, D.EMPTY_BAN), /只有禁用位/);
});

test('结束本局：比分加一，败方下一局在蓝方，BP 没完成不能结束', () => {
    const s = D.newSeries({ bestOf: 3 });
    throws(() => D.finishGame(s, 'a'), /BP 还没完成/);
    playDraft(s, pool(1));
    assert.ok(D.isComplete(s));
    D.finishGame(s, 'a');
    assert.deepStrictEqual(s.score, { a: 1, b: 0 });
    assert.strictEqual(s.game.blue, 'b');
    assert.strictEqual(s.games[0].blue, 'a');
    assert.ok(D.isEmpty(s));
});

test('全局 BP · 双边：之前任何一方选过的，双方都不能选也不能禁；禁过的不锁', () => {
    const s = D.newSeries({ fearless: 'global' });
    playDraft(s, pool(1));          // 蓝方 a：禁 0,2,4,13,15；选 6,9,10,17,18
    D.finishGame(s, 'b');           // a 输，下一局 a 还在蓝方
    const bluePick = s.games[0].picks.blue[0];
    const redPick = s.games[0].picks.red[0];
    const ban = s.games[0].bans.blue[0];
    throws(() => D.fill(s, { side: 'blue', type: 'pick', index: 0 }, redPick), /全局 BP：队伍 B 在第 1 局已选用/);
    throws(() => D.fill(s, { side: 'red', type: 'pick', index: 0 }, bluePick), /全局 BP/);
    throws(() => D.fill(s, D.currentTurn(s), bluePick), /全局 BP/);                    // 禁用位也拦
    D.fill(s, { side: 'red', type: 'pick', index: 0 }, ban);                            // 上一局禁过的照样能选
});

test('全局 BP · 仅本队：只锁本队选过的，对面能选，禁用不受限；换边后跟着队伍走', () => {
    const s = D.newSeries({ fearless: 'team' });
    playDraft(s, pool(1));
    const aPick = s.game.picks.blue[0];                         // a 在蓝方选的
    D.finishGame(s, 'a');           // a 赢，下一局 a 在红方
    assert.strictEqual(D.sideOf(s, 'a'), 'red');
    throws(() => D.fill(s, { side: 'red', type: 'pick', index: 0 }, aPick), /全局 BP：本队第 1 局已选用/);
    D.fill(s, { side: 'blue', type: 'pick', index: 0 }, aPick);                         // b 能选 a 用过的
    D.clear(s, { side: 'blue', type: 'pick', index: 0 });
    D.fill(s, D.currentTurn(s), aPick);                                                 // 禁用不受限
});

test('不启用全局 BP 时每局独立', () => {
    const s = D.newSeries({ fearless: 'off' });
    playDraft(s, pool(1));
    const pick = s.game.picks.blue[0];
    D.finishGame(s, 'a');
    D.fill(s, { side: 'red', type: 'pick', index: 0 }, pick);
});

test('系列赛：拿到赛点就结束，不能再填；赛制改不能让系列赛直接结束', () => {
    const s = D.newSeries({ bestOf: 3, fearless: 'off' });
    playDraft(s, pool(1));
    D.finishGame(s, 'a');
    throws(() => D.setBestOf(s, 1), /直接结束/);
    playDraft(s, pool(2));
    D.finishGame(s, 'a');
    assert.strictEqual(D.decided(s), 'a');
    throws(() => D.fill(s, D.currentTurn(s), 'ahri'), /系列赛已经结束/);
    D.setBestOf(s, 5);                                                                  // 改大了接着打
    assert.strictEqual(D.decided(s), null);
    D.fill(s, D.currentTurn(s), 'ahri');
});

test('换边只在本局开始前；改全局 BP 模式会检查本局已填的英雄', () => {
    const s = D.newSeries({ fearless: 'off' });
    D.swapSides(s);
    assert.strictEqual(s.game.blue, 'b');
    playDraft(s, pool(1));
    const pick = s.game.picks.red[0];               // a 在红方选的
    D.finishGame(s, 'b');
    D.fill(s, { side: 'blue', type: 'pick', index: 0 }, pick);      // a 这局在蓝方，又选了它
    throws(() => D.swapSides(s), /重开本局/);
    throws(() => D.setFearless(s, 'global'), /先改掉或重开本局/);
    D.resetGame(s);
    D.setFearless(s, 'global');
    assert.strictEqual(s.fearless, 'global');
});

test('新系列赛保留队名和设置；存档校验', () => {
    const s = D.newSeries({ bestOf: 5, fearless: 'team', teams: { a: { name: 'TT' }, b: { name: 'FP' } } });
    playDraft(s, pool(1));
    D.finishGame(s, 'a');
    const fresh = D.newSeriesFrom(s);
    assert.deepStrictEqual([fresh.bestOf, fresh.fearless, fresh.teams.a.name, fresh.teams.b.name, fresh.games.length], [5, 'team', 'TT', 'FP', 0]);
    assert.ok(D.validState(JSON.parse(JSON.stringify(s))));
    assert.ok(!D.validState({ bestOf: 2 }));
    assert.ok(!D.validState(null));
});

console.log(`${passed} 条通过${process.exitCode ? '，有失败' : ''}`);
