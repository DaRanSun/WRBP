// 联机房间的规则：谁能做什么、预选和锁定、双端互相确认、撤销。
// 纯函数，不碰网络和存储；Worker（worker/index.mjs）和 Node 自检（tools/check-room.mjs）共用。BP 本身的规则在 draft.js。
//
//   room = {
//     id, mode: "duo" | "trio",             双端：双方教练；三端：双方教练 + 裁判
//     createdAt, updatedAt,
//     step,                                  BP / 比分 / 设置每变一次加一
//     seq,                                   请求编号
//     series,                                draft.js 的系列赛状态
//     hover: { turn, slug } | null,          当前这一手的预选，所有人都看得到（和游戏里一样）
//     proposal: { id, by, type, args, label, step } | null,   双端：等对方同意的请求
//     undo: [{ series: JSON 字符串, label }],  最近的改动，撤销用
//     last: string | null,                   最近一次改动的说明，页面上显示
//   }
//
// 身份：'a' / 'b' 是两队教练（跟着队伍走，换边不影响），'ref' 是裁判，'view' 是观战。
//
// 需要权限的操作（撤销、记胜负、换边、改赛制和全局 BP、重开本局、新系列赛）：
//   裁判直接执行；三端模式下教练不能做；双端模式下教练发起请求，对方同意才执行。
//   两个例外不用对方同意：教练记“对方胜”（认输），上一局输的一方在下一局开始前换边（败方选边）。
import '../assets/js/draft.js';

const D = globalThis.WRBP.draft;

export const MODES = { duo: '双端', trio: '三端' };
export const ROLES = ['a', 'b', 'ref', 'view'];
const UNDO_LIMIT = 30;
const NAME_LIMIT = 16;

const isCoach = role => role === 'a' || role === 'b';
const teamName = (room, team) => room.series.teams[team].name;

function cleanName(value, fallback) {
    return String(value == null ? '' : value).trim().slice(0, NAME_LIMIT) || fallback;
}

function slotName(room, ref) {
    const team = teamName(room, D.teamOn(room.series, ref.side));
    return ref.type === 'ban' ? `${team} 禁用 ${ref.index + 1}` : `${team} ${ref.index + 1} 楼`;
}

function valueName(ctx, value) {
    return value === D.EMPTY_BAN ? '空 Ban' : ctx.name(value);
}

function checkChampion(ctx, slug) {
    if (typeof slug !== 'string' || !ctx.isChampion(slug)) throw new Error('没有这个英雄');
}

function parseRef(value) {
    const ref = value && { side: value.side, type: value.type, index: value.index };
    if (!ref || !Number.isInteger(ref.index) || !D.turnOf(ref)) throw new Error('没有这一格');
    return ref;
}

export function createRoom(options, now) {
    const { id, mode, teams, bestOf, fearless } = options || {};
    if (!MODES[mode]) throw new Error('模式只能是双端或三端');
    if (!D.BEST_OF.includes(bestOf)) throw new Error('赛制只支持 BO1 / BO3 / BO5 / BO7');
    if (!D.FEARLESS[fearless]) throw new Error('未知的全局 BP 模式');
    const series = D.newSeries({
        bestOf,
        fearless,
        teams: { a: { name: cleanName(teams && teams.a, '队伍 A') }, b: { name: cleanName(teams && teams.b, '队伍 B') } },
    });
    return { id, mode, createdAt: now, updatedAt: now, step: 0, seq: 0, series, hover: null, proposal: null, undo: [], last: null };
}

// 给页面看的状态：撤销记录只给最近一条的说明。
export function snapshot(room) {
    const top = room.undo[room.undo.length - 1];
    return {
        id: room.id,
        mode: room.mode,
        step: room.step,
        series: room.series,
        hover: room.hover,
        proposal: room.proposal && { id: room.proposal.id, by: room.proposal.by, label: room.proposal.label },
        last: room.last,
        undoLabel: top ? top.label : null,
        updatedAt: room.updatedAt,
    };
}

// 改 BP / 比分 / 设置都走这里：记一步撤销，清掉预选和没处理的请求（情况变了，请求就作废）。
function mutate(room, label, change) {
    const before = JSON.stringify(room.series);
    try {
        const replaced = change(room.series);
        if (replaced) room.series = replaced;
    } catch (error) {
        room.series = JSON.parse(before);
        throw error;
    }
    room.undo.push({ series: before, label });
    if (room.undo.length > UNDO_LIMIT) room.undo.shift();
    room.step += 1;
    room.hover = null;
    room.proposal = null;
    room.last = label;
}

// 教练这一手：轮到自己这一方，而且 turn（页面以为的当前手）没过期。
function ownTurn(room, role, command) {
    if (!isCoach(role)) throw new Error(role === 'ref' ? '裁判直接点格子或英雄来改' : '观战不能操作');
    if (D.decided(room.series)) throw new Error('系列赛已经结束');
    const turn = D.currentTurn(room.series);
    if (!turn) throw new Error('本局 BP 已经完成');
    if (command.turn !== undefined && command.turn !== turn.n) throw new Error('BP 已经往下走了，刚才那一下没有生效');
    if (turn.side !== D.sideOf(room.series, role)) {
        const other = teamName(room, D.teamOn(room.series, turn.side));
        throw new Error(`还没轮到你，现在是 ${other} ${D.TYPE_NAMES[turn.type]}`);
    }
    return turn;
}

// ---- 需要权限的操作 ----
// args：从命令里取干净的参数；label：给人看的说明；run：执行（不合规则就抛错）；
// direct：教练不用对方同意就能做的情况。

const ACTIONS = {
    undo: {
        args: () => ({}),
        label: room => `撤销上一步（${room.undo.length ? room.undo[room.undo.length - 1].label : '无'}）`,
        run(room) {
            const entry = room.undo.pop();
            if (!entry) throw new Error('没有可以撤销的操作');
            const series = JSON.parse(entry.series);
            series.teams = room.series.teams;          // 队名不跟着撤销
            room.series = series;
            room.step += 1;
            room.hover = null;
            room.proposal = null;
            room.last = `已撤销：${entry.label}`;
        },
    },
    finish: {
        args: command => ({ winner: command.winner }),
        label: (room, args) => `记录本局 ${teamName(room, args.winner)} 胜`,
        direct: (room, role, args) => args.winner !== role,          // 认输
        run(room, args) {
            if (!isCoach(args.winner)) throw new Error('胜者只能是两支队伍之一');
            mutate(room, `第 ${room.series.games.length + 1} 局 ${teamName(room, args.winner)} 胜`, s => D.finishGame(s, args.winner));
        },
    },
    swap: {
        args: () => ({}),
        label: () => '交换本局红蓝方',
        // 败方选边：上一局输的一方，在下一局开始 BP 之前。
        direct: (room, role) => {
            const games = room.series.games;
            return games.length > 0 && games[games.length - 1].winner !== role && D.isEmpty(room.series);
        },
        run(room) {
            mutate(room, '交换红蓝方', s => D.swapSides(s));
            const blue = room.series.game.blue;
            room.last = `交换红蓝方：${teamName(room, blue)} 蓝方，${teamName(room, D.OTHER[blue])} 红方`;
        },
    },
    settings: {
        args: command => ({
            bestOf: command.bestOf === undefined ? undefined : Number(command.bestOf),
            fearless: command.fearless,
        }),
        label: (room, args) => [
            args.bestOf !== undefined ? `赛制改为 BO${args.bestOf}` : '',
            args.fearless !== undefined && D.FEARLESS[args.fearless] ? `改为${D.FEARLESS[args.fearless].name}` : '',
        ].filter(Boolean).join('，') || '改设置',
        run(room, args) {
            if (args.bestOf === undefined && args.fearless === undefined) throw new Error('没有要改的设置');
            const label = ACTIONS.settings.label(room, args);
            mutate(room, label, s => {
                if (args.bestOf !== undefined) D.setBestOf(s, args.bestOf);
                if (args.fearless !== undefined) D.setFearless(s, args.fearless);
            });
        },
    },
    reset: {
        args: () => ({}),
        label: () => '重开本局（清空本局 BP）',
        run(room) {
            if (D.isEmpty(room.series)) throw new Error('本局还没开始');
            mutate(room, '重开本局', s => D.resetGame(s));
        },
    },
    newSeries: {
        args: () => ({}),
        label: () => '开新系列赛（比分清零）',
        run(room) {
            mutate(room, '新系列赛', s => D.newSeriesFrom(s));
        },
    },
};

// 在一份轻量的副本上试跑，做不了就抛错（只复制系列赛和最近一条撤销记录）。
function tryRun(room, type, args, ctx) {
    const copy = { ...room, series: structuredClone(room.series), undo: room.undo.slice(-1), proposal: null };
    ACTIONS[type].run(copy, args, ctx);
}

function privileged(type) {
    return (room, role, command, ctx) => {
        const action = ACTIONS[type];
        const args = action.args(command);
        if (role === 'ref') {
            action.run(room, args, ctx);
            return true;
        }
        if (!isCoach(role)) throw new Error('观战不能操作');
        if (action.direct && action.direct(room, role, args)) {
            action.run(room, args, ctx);
            return true;
        }
        if (room.mode === 'trio') throw new Error('三端模式下这一步由裁判操作');
        if (room.proposal) throw new Error('上一个请求还在等对方确认');
        tryRun(room, type, args, ctx);                          // 先试一遍：做不了的请求不发出去
        room.seq += 1;
        room.proposal = { id: room.seq, by: role, type, args, label: action.label(room, args, ctx), step: room.step };
        room.last = `${teamName(room, role)} 请求：${room.proposal.label}`;
        return true;
    };
}

// ---- 命令表 ----
// 每个处理函数返回 true 表示状态变了（要存盘、广播），不合规则就抛出带中文说明的 Error。

const HANDLERS = {
    hover(room, role, command, ctx) {
        const turn = ownTurn(room, role, command);
        if (command.slug === null) {
            const had = !!room.hover;
            room.hover = null;
            return had;
        }
        checkChampion(ctx, command.slug);
        const reason = D.blockedReason(room.series, turn, command.slug);
        if (reason) throw new Error(reason);
        if (room.hover && room.hover.turn === turn.n && room.hover.slug === command.slug) return false;
        room.hover = { turn: turn.n, slug: command.slug };
        return true;
    },

    lock(room, role, command, ctx) {
        const turn = ownTurn(room, role, command);
        const slug = command.slug || (room.hover && room.hover.turn === turn.n ? room.hover.slug : null);
        if (!slug) throw new Error('先点一个英雄预选，再锁定');
        checkChampion(ctx, slug);
        mutate(room, `${teamName(room, role)} ${D.TYPE_NAMES[turn.type]} ${ctx.name(slug)}`, s => D.fill(s, turn, slug));
        return true;
    },

    skip(room, role, command) {
        const turn = ownTurn(room, role, command);
        if (turn.type !== 'ban') throw new Error('只有禁用可以空 Ban');
        mutate(room, `${teamName(room, role)} 空 Ban`, s => D.fill(s, turn, D.EMPTY_BAN));
        return true;
    },

    // 裁判直接改任意一格（value 为 null 是清空）。
    fill(room, role, command, ctx) {
        if (role !== 'ref') throw new Error('只有裁判能直接改格子');
        const ref = parseRef(command.ref);
        const value = command.value;
        const current = D.getSlot(room.series, ref);
        if (value === null) {
            if (current === null) return false;
            mutate(room, `裁判清空 ${slotName(room, ref)}`, s => D.clear(s, ref));
            return true;
        }
        if (value !== D.EMPTY_BAN) checkChampion(ctx, value);
        if (current === value) return false;
        mutate(room, `裁判：${slotName(room, ref)} ${valueName(ctx, value)}`, s => D.fill(s, ref, value));
        return true;
    },

    rename(room, role, command) {
        const team = command.team;
        if (!isCoach(team)) throw new Error('没有这支队伍');
        if (role !== 'ref' && role !== team) throw new Error('只能改自己队伍的名字');
        const name = cleanName(command.name, teamName(room, team));
        if (name === teamName(room, team)) return false;
        room.series.teams[team].name = name;
        return true;
    },

    respond(room, role, command, ctx) {
        const proposal = room.proposal;
        if (!proposal || proposal.id !== command.id) throw new Error('这个请求已经失效');
        if (!isCoach(role) || role === proposal.by) throw new Error('要由对方确认');
        if (!command.accept) {
            room.proposal = null;
            room.last = `${teamName(room, role)} 拒绝了：${proposal.label}`;
            return true;
        }
        if (proposal.step !== room.step) {
            room.proposal = null;
            room.last = '请求发出后情况有变，已作废';
            return true;
        }
        room.proposal = null;
        ACTIONS[proposal.type].run(room, proposal.args, ctx);
        room.last = `${room.last}（${teamName(room, role)} 同意）`;
        return true;
    },

    cancel(room, role, command) {
        const proposal = room.proposal;
        if (!proposal || proposal.id !== command.id) throw new Error('这个请求已经失效');
        if (role !== proposal.by && role !== 'ref') throw new Error('只能撤回自己发起的请求');
        room.proposal = null;
        room.last = `${teamName(room, proposal.by)} 撤回了请求`;
        return true;
    },
};
Object.keys(ACTIONS).forEach(type => { HANDLERS[type] = privileged(type); });

// 执行一条命令。changed = true 时要存盘、广播。出错时整个房间原样不动。
export function apply(room, role, command, ctx, now) {
    const handler = command && Object.prototype.hasOwnProperty.call(HANDLERS, command.type) ? HANDLERS[command.type] : null;
    if (!handler) throw new Error('未知的操作');
    if (!ROLES.includes(role)) throw new Error('身份不对');
    const changed = handler(room, role, command, ctx);
    if (changed) room.updatedAt = now;
    return changed;
}

// 这一身份能不能做某个需要权限的操作：'direct'（直接做）、'propose'（发请求等对方同意）、null（不能做）。
// 现在根本做不了的（没有可撤销的、BP 没完成不能记胜负……）也是 null，页面上按钮是灰的。改设置要看改成什么，不试跑。
export function permission(room, role, type, args) {
    const action = ACTIONS[type];
    if (!action) return null;
    let mode = null;
    if (role === 'ref') mode = 'direct';
    else if (isCoach(role)) {
        if (action.direct && action.direct(room, role, args || {})) mode = 'direct';
        else if (room.mode === 'duo') mode = 'propose';
    }
    if (mode && type !== 'settings') {
        try {
            tryRun(room, type, args || {}, { name: slug => slug, isChampion: () => true });
        } catch (error) {
            return null;
        }
    }
    return mode;
}

// 随状态一起推给每个身份，页面据此决定按钮怎么显示，不用自己再写一遍规则。
export function permissions(room, role) {
    return {
        undo: permission(room, role, 'undo'),
        finish: { a: permission(room, role, 'finish', { winner: 'a' }), b: permission(room, role, 'finish', { winner: 'b' }) },
        swap: permission(room, role, 'swap'),
        settings: permission(room, role, 'settings'),
        reset: permission(room, role, 'reset'),
        newSeries: permission(room, role, 'newSeries'),
    };
}
