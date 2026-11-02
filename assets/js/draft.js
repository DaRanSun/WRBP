// BP 规则：竞技征召的顺序、本局去重、全局 BP（无畏征召）、系列赛比分。不碰页面，Node 里也能跑（tools/check-draft.js）。
//
// 状态是能直接 JSON 化的对象，函数原地修改它：
//
//   state = {
//     bestOf: 3,
//     fearless: "global" | "team" | "off",
//     teams: { a: { name }, b: { name } },      队伍用 a / b 标识，和红蓝方无关
//     score: { a: 0, b: 0 },
//     games: [{ n, blue, winner, bans: { blue: [], red: [] }, picks: { blue: [], red: [] } }],   打完的局
//     game: { blue: "a", bans: { blue: [5 格], red: [5 格] }, picks: { blue: [5 格], red: [5 格] } },  正在 BP 的局
//   }
//
// 每一格：null = 还没填；"" = 空 Ban（只有禁用位能空）；其余是英雄 slug。
// 格子按队内顺位存（蓝方第 1 个禁用、红方第 3 个选用……），和 WRPedia 的 picks / bans 一致。
// “当前手”永远是顺序里第一个还空着的格子，所以跳着填、回头改、清掉重来都不会把流程弄乱。
(function (root) {
    'use strict';

    const SIDES = ['blue', 'red'];
    const OTHER = { a: 'b', b: 'a' };
    const SIDE_NAMES = { blue: '蓝方', red: '红方' };
    const TYPE_NAMES = { ban: '禁用', pick: '选用' };
    const EMPTY_BAN = '';
    const BEST_OF = [1, 3, 5, 7];

    // 竞技征召，照 WROB config/draft.yaml 的 tournament（赛事征召）。B = 蓝方、R = 红方，一个记号一手。不计时。
    const FORMAT = {
        name: '竞技征召',
        phases: [
            { key: 'ban1', name: '第一轮禁用', type: 'ban', order: 'B R B R B R' },
            { key: 'pick1', name: '第一轮选用', type: 'pick', order: 'B R R B B R' },
            { key: 'ban2', name: '第二轮禁用', type: 'ban', order: 'R B R B' },
            { key: 'pick2', name: '第二轮选用', type: 'pick', order: 'R B B R' },
        ],
    };

    // 全局 BP，照 WROB 的无畏征召（state/series.py）。
    const FEARLESS = {
        global: { name: '全局 BP · 双边', hint: '之前任何一方选过的英雄，双方都不能再选，也不能再禁' },
        team: { name: '全局 BP · 仅本队', hint: '只锁本队之前选过的英雄，对面照样能选，禁用不受限' },
        off: { name: '不启用全局 BP', hint: '每局独立 BP' },
    };

    function buildTurns(format) {
        const count = { blue: { ban: 0, pick: 0 }, red: { ban: 0, pick: 0 } };
        const turns = [];
        format.phases.forEach(phase => {
            phase.order.trim().split(/\s+/).forEach(mark => {
                const side = mark === 'B' ? 'blue' : 'red';
                turns.push({ n: turns.length, phase: phase.key, phaseName: phase.name, type: phase.type, side, index: count[side][phase.type]++ });
            });
        });
        return turns;
    }

    const TURNS = buildTurns(FORMAT);
    const SLOT_COUNT = {
        ban: Math.max(...SIDES.map(side => TURNS.filter(t => t.side === side && t.type === 'ban').length)),
        pick: Math.max(...SIDES.map(side => TURNS.filter(t => t.side === side && t.type === 'pick').length)),
    };

    function turnOf(ref) {
        return TURNS.find(t => t.side === ref.side && t.type === ref.type && t.index === ref.index) || null;
    }

    // ---- 系列赛 ----

    function newGame(blue) {
        const slots = type => ({ blue: Array(SLOT_COUNT[type]).fill(null), red: Array(SLOT_COUNT[type]).fill(null) });
        return { blue, bans: slots('ban'), picks: slots('pick') };
    }

    function newSeries(options) {
        options = options || {};
        return {
            bestOf: BEST_OF.includes(options.bestOf) ? options.bestOf : 3,
            fearless: FEARLESS[options.fearless] ? options.fearless : 'global',
            teams: {
                a: { name: (options.teams && options.teams.a && options.teams.a.name) || '队伍 A' },
                b: { name: (options.teams && options.teams.b && options.teams.b.name) || '队伍 B' },
            },
            score: { a: 0, b: 0 },
            games: [],
            game: newGame('a'),
        };
    }

    function teamOn(state, side, game) {
        const blue = (game || state.game).blue;
        return side === 'blue' ? blue : OTHER[blue];
    }

    function sideOf(state, team) {
        return state.game.blue === team ? 'blue' : 'red';
    }

    function winsNeeded(state) {
        return Math.floor(state.bestOf / 2) + 1;
    }

    // 已经拿下系列赛的队伍，没有则为 null。
    function decided(state) {
        return ['a', 'b'].find(team => state.score[team] >= winsNeeded(state)) || null;
    }

    // ---- 这一局 ----

    function slotsOf(game, type) {
        return type === 'ban' ? game.bans : game.picks;
    }

    function getSlot(state, ref) {
        return slotsOf(state.game, ref.type)[ref.side][ref.index];
    }

    function currentTurn(state) {
        return TURNS.find(t => getSlot(state, t) === null) || null;
    }

    function filledCount(state) {
        return TURNS.filter(t => getSlot(state, t) !== null).length;
    }

    function isEmpty(state) {
        return filledCount(state) === 0;
    }

    function isComplete(state) {
        return currentTurn(state) === null;
    }

    // 这一局已经用掉的英雄：slug → 原因。ignore 是正在改的那一格，不算它自己。
    function usedThisGame(state, ignore) {
        const used = {};
        TURNS.forEach(t => {
            if (ignore && t.side === ignore.side && t.type === ignore.type && t.index === ignore.index) return;
            const slug = getSlot(state, t);
            if (slug) used[slug] = { reason: `本局${SIDE_NAMES[t.side]}已${TYPE_NAMES[t.type]}`, kind: t.type, side: t.side };
        });
        return used;
    }

    // 全局 BP 锁住的英雄，按这一局的红蓝方整理。
    // 返回 { bans: 禁用位是否也受限, sides: { blue: { slug: { reason, game } }, red: {…} } }。
    //   global：之前任何一方选过的，双方都不能再选，也没必要再禁。
    //   team：只锁本队自己选过的，对面还能选，所以禁用位不受限。
    function fearlessBlocked(state, mode) {
        mode = mode || state.fearless;
        const sides = { blue: {}, red: {} };
        if (mode !== 'off') {
            state.games.forEach(game => {
                SIDES.forEach(thenSide => {
                    const picker = teamOn(state, thenSide, game);
                    game.picks[thenSide].forEach(slug => {
                        if (!slug) return;
                        SIDES.forEach(side => {
                            if (mode === 'global' || teamOn(state, side) === picker) {
                                const reason = mode === 'global'
                                    ? `全局 BP：${state.teams[picker].name} 在第 ${game.n} 局已选用`
                                    : `全局 BP：本队第 ${game.n} 局已选用`;
                                sides[side][slug] = sides[side][slug] || { reason, game: game.n };
                            }
                        });
                    });
                });
            });
        }
        return { bans: mode === 'global', sides };
    }

    // 这一格能不能放这个英雄。能放返回 null，否则返回原因。
    function blockedReason(state, ref, slug, mode) {
        if (!slug) return null;
        const used = usedThisGame(state, ref)[slug];
        if (used) return used.reason;
        const fearless = fearlessBlocked(state, mode);
        if (ref.type === 'pick' || fearless.bans) {
            const locked = fearless.sides[ref.side][slug];
            if (locked) return locked.reason;
        }
        return null;
    }

    // 填一格。value 是英雄 slug，或 EMPTY_BAN（只限禁用位）。不合规则时抛出带中文说明的 Error。
    function fill(state, ref, value) {
        if (decided(state)) throw new Error('系列赛已经结束');
        if (!turnOf(ref)) throw new Error('没有这一格');
        if (value === EMPTY_BAN) {
            if (ref.type !== 'ban') throw new Error('只有禁用位可以空 Ban');
        } else {
            const reason = blockedReason(state, ref, value);
            if (reason) throw new Error(reason);
        }
        slotsOf(state.game, ref.type)[ref.side][ref.index] = value;
    }

    function clear(state, ref) {
        if (!turnOf(ref)) throw new Error('没有这一格');
        slotsOf(state.game, ref.type)[ref.side][ref.index] = null;
    }

    function resetGame(state) {
        state.game = newGame(state.game.blue);
    }

    // 换边只在这一局还没开始时可以：全局 BP 仅本队时，换边会改变哪些英雄被锁。
    function swapSides(state) {
        if (!isEmpty(state)) throw new Error('本局已经开始，重开本局后才能换边');
        state.game.blue = OTHER[state.game.blue];
    }

    // 改全局 BP 的模式。这一局已经填了的英雄要是在新模式下不合规则，就不改。
    function setFearless(state, mode) {
        if (!FEARLESS[mode]) throw new Error('未知的全局 BP 模式');
        const conflict = TURNS.some(t => {
            const slug = getSlot(state, t);
            return slug && blockedReason(state, t, slug, mode);
        });
        if (conflict) throw new Error('本局已经填了在新规则下会被锁住的英雄，先改掉或重开本局');
        state.fearless = mode;
    }

    // 改赛制。改完不能让系列赛直接结束（比如 2:0 时从 BO5 改成 BO3）；已经结束的系列赛可以改大了接着打。
    function setBestOf(state, bestOf) {
        if (!BEST_OF.includes(bestOf)) throw new Error('赛制只支持 BO1 / BO3 / BO5 / BO7');
        if (bestOf === state.bestOf) return;
        if (Math.max(state.score.a, state.score.b) >= Math.floor(bestOf / 2) + 1) {
            throw new Error(`当前比分 ${state.score.a} : ${state.score.b}，改成 BO${bestOf} 系列赛就直接结束了`);
        }
        state.bestOf = bestOf;
    }

    // 记下这一局的结果，比分加一。下一局默认败方在蓝方，开始 BP 前可以换边。
    function finishGame(state, winner) {
        if (!OTHER[winner]) throw new Error('胜者只能是队伍 a 或 b');
        if (!isComplete(state)) throw new Error('BP 还没完成');
        if (decided(state)) throw new Error('系列赛已经结束');
        const game = state.game;
        state.games.push({
            n: state.games.length + 1,
            blue: game.blue,
            winner,
            bans: { blue: game.bans.blue.slice(), red: game.bans.red.slice() },
            picks: { blue: game.picks.blue.slice(), red: game.picks.red.slice() },
        });
        state.score[winner] += 1;
        state.game = newGame(OTHER[winner]);
    }

    function newSeriesFrom(state) {
        return newSeries({ bestOf: state.bestOf, fearless: state.fearless, teams: state.teams });
    }

    // 读存档时检查一遍形状，不对就返回 null（页面开一个新的）。
    function validState(state) {
        try {
            if (!state || !BEST_OF.includes(state.bestOf) || !FEARLESS[state.fearless]) return false;
            if (!state.teams.a || !state.teams.b || !OTHER[state.game.blue]) return false;
            return TURNS.every(t => {
                const value = getSlot(state, t);
                return value === null || typeof value === 'string';
            }) && Array.isArray(state.games);
        } catch (error) {
            return false;
        }
    }

    root.WRBP = root.WRBP || {};
    root.WRBP.draft = {
        SIDES, OTHER, SIDE_NAMES, TYPE_NAMES, EMPTY_BAN, BEST_OF, FORMAT, FEARLESS, TURNS, SLOT_COUNT,
        turnOf, newSeries, newSeriesFrom, newGame, teamOn, sideOf, winsNeeded, decided,
        getSlot, currentTurn, filledCount, isEmpty, isComplete, usedThisGame, fearlessBlocked, blockedReason,
        fill, clear, resetGame, swapSides, setFearless, setBestOf, finishGame, validState,
    };
})(typeof window !== 'undefined' ? window : globalThis);
