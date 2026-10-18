/**
 * OFM Addition — browser half.
 *
 * Contributes one settings section (`settings.section` id `ofm-addition`) that
 * sits directly under Our Free Model's own page. Everything it shows comes from
 * the host half's `/api/ofm-addition` routes; nothing about the feature lives in
 * the browser except the rendering.
 *
 * No build step, no dependency beyond the `react` the shell already provides,
 * and all colour comes from theme variables so the page survives a scheme switch.
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-ofm-addition',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useRef, useCallback, useMemo } = React

    const NS = 'settings.ofmAddition'
    /** `slots` is required; `locale` is reached through `ctx.get` so a shell
     *  without it degrades to the English/Chinese dictionary picked off the
     *  document language rather than the section failing to mount. */
    const inject = ['slots']

    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: 'OFM 增强',
        title: 'OFM Addition',
        subtitle: 'Our Free Model 的附属插件 · 截断自动续写',
        master: '自动续写',
        masterHint: '当回答因达到输出 token 上限被截断时，替你发送「继续」，让模型从中断处接着输出。',
        'state.on': '已开启',
        'state.off': '已关闭',

        'section.behavior': '续写规则',
        'field.maxContinuations': '连续续写上限',
        'hint.maxContinuations': '同一次截断最多自动续写几次。选「不限」就一直续下去，直到上下文满了为止。',
        'unlimited': '不限',
        'field.delayMs': '发送前等待',
        'hint.delayMs': '给「停止」留出窗口。这段时间里你打字、点停止或切换模型，本次续写都会取消。',
        'field.prompt': '提示词',
        'preset.explicit': '明确',
        'preset.simple': '简单',
        'field.customPrompt': '自定义提示词',
        'hint.customPrompt': '留空则使用上面的预设。',
        'preview': '将发送的内容',

        'field.contextGuard': '上下文保护',
        'hint.contextGuard':
          '下一条请求的 prompt 已经接近模型上下文窗口时，不再续写。这是「不限」时的唯一刹车。',
        'field.contextRatio': '在窗口的这个位置停下',
        'hint.contextRatio':
          '按「窗口 − 本次请求预留的输出」算 prompt 自己的预算，再取这个比例。100% 表示只在字面上的极限处停；留出余量可以避免撞上溢出报错。',
        'warn.unbounded':
          '「不限」且上下文保护已关闭：续写会一直进行下去，直到上游报出上下文溢出。建议至少保留其中一道闸。',
        'agent.overflowed': '上下文已满',

        'section.transcript': '对话呈现',
        'field.foldContinuations': '折叠自动续写',
        'hint.foldContinuations':
          '把本插件发出的「继续」和它已接手的截断提示从对话里收起来，让一轮连续的输出看起来就是一条回答。点下面的次数标注可临时展开。',
        'field.showContinueCount': '显示自动续写次数',
        'hint.showContinueCount':
          '在任务完成或上下文停下时，最后一行输出的时间后面标注这一轮自动续写了多少次。',
        'badge': '（已自动继续 {n} 次）',
        'badge.title': '这一轮自动续写了 {n} 次，因「{ended}」结束。点击{state}。',
        'badge.reveal': '展开这些内容',
        'badge.hide': '重新折叠',
        'badge.ends.completed': '任务完成',
        'badge.ends.aborted': '被停止',
        'badge.ends.error': '出错',
        'badge.ends.blocked': '被阻止',
        'badge.ends.unknown': '结束',
        'badge.ends.user-input': '你接手了',
        'badge.ends.context-overflow': '到达上下文上限',
        'folded.none': '这一轮没有可折叠的内容',

        'section.scope': '生效范围',
        'field.ofmOnly': '只对 Our Free Model 生效',
        'hint.ofmOnly': '本插件是 Our Free Model 的附属。开着时只作用于它的路由，其它供应商完全不碰；关掉才轮到下面的白名单。',
        'field.ofmProviders': 'Our Free Model 的路由',
        'hint.ofmProviders': '一行一个或逗号分隔，支持 * 通配。默认覆盖主路由与地区受限路由。',
        'field.providers': '仅这些 provider',
        'field.models': '仅这些模型',
        'hint.scope': '一行一个或逗号分隔，支持 * 通配（如 our-free-model*）。留空表示不限。只在关闭上面的「只对 Our Free Model 生效」时使用。',
        'field.includeSubagents': '子代理也续写',
        'hint.includeSubagents': '默认只处理主对话；子代理通常由它自己的父级流程收尾。',
        'field.skipOnTruncatedToolCall': '截断落在工具调用上时跳过',
        'hint.skipOnTruncatedToolCall': '开启后，若输出恰好断在工具调用的参数中间就不再自动续写，等你确认。',
        'field.messageMode': '消息呈现方式',
        'mode.user': '用户气泡',
        'mode.notice': '自动化标记',
        'hint.messageMode':
          '用户气泡：对话里就是一条「继续」，和手动发送一致。自动化标记：标注为插件触发的通知，一眼能看出不是你自己发的。',

        'section.status': '运行状态',
        'stat.sent': '已发送',
        'stat.recent': '最近 24 小时',
        'stat.budget': '预算用尽',
        'stat.context': '上下文停下',
        'agents.title': '活跃会话',
        'agents.empty': '当前没有正在跟踪的会话。',
        'agents.armed': '已就绪',
        'agents.idle': '空闲',
        'agents.running': '运行中',
        'agents.subagent': '子代理',
        'agents.round': '第 {n} 次',
        'nudge': '立即续写',
        'nudge.sent': '已发送',
        'nudge.busy': '该会话正在运行，等它停下来再试。',
        'reset': '清空统计',
        'reset.done': '已清空',
        'history.title': '最近记录',
        'history.empty': '暂无记录。',
        'col.time': '时间',
        'col.result': '结果',
        'col.session': '会话',
        'col.model': '模型',

        'loading': '读取中…',
        'backend': '无法连接插件后端',
        'retry': '重试',
        'saved': '已保存',
        'saveFailed': '保存失败',

        'outcome.sent': '已发送续写',
        'outcome.disabled': '插件已关闭',
        'outcome.no-pending': '没有待续的截断',
        'outcome.agent-gone': '会话已结束',
        'outcome.agent-busy': '会话正在运行',
        'outcome.user-driving': '你已排入新的输入',
        'outcome.budget-spent': '连续续写已达上限',
        'outcome.context-full': '上下文已接近上限',
        'outcome.context-overflow': '上下文溢出，已停止',
        'outcome.route-filtered': '当前模型不在生效范围',
        'outcome.subagent-filtered': '子代理不自动续写',
        'outcome.tool-call-truncated': '截断落在工具调用上',
        'outcome.disposed': '插件已卸载',

        'foot.rule': '规则',
        'foot.ruleText':
          '只有模型真的停在输出上限（finish_reason = length）才会触发；正常结束、报错、你按下的停止都不会。每次触发前都会重新确认一次状态，你永远优先。',
        'nav.models': 'OFM 模型参数',
        'title.models': 'OFM 模型参数',
        'subtitle.models': 'Our Free Model 的每个模型 · 请求参数',
        'models.count': '{total} 个模型 · {set} 个已配置',
        'models.list': '模型列表',
        'models.refresh': '重新读取',
        'models.search': '搜索模型名或路由',
        'models.onlySet': '只看已配置',
        'models.scope': '生效范围',
        'models.scope.hint': '一行一个 provider 通配（支持 *），决定这个页面列出哪些模型。参数只会写到你在本页配置过的模型上，其它模型一律不碰。',
        'models.empty': '这个范围里没有模型可以配置。',
        'models.state.untouched': '未配置',
        'models.state.defaults': '模型默认',
        'models.effort': '思考档位',
        'models.effort.default': '模型默认',
        'models.effort.none': '该模型未声明思考档位，请求里不会带 effort；这里只能设置输出上限与采样参数。',
        'models.effort.session': '会话临时选择优先',
        'models.effort.session.hint': '开启后，你在模型选择器里临时选的档位覆盖这里的设置；关闭时以本页为准。',
        'models.max': '输出上限',
        'models.max.auto': '模型默认',
        'models.max.top': '顶配 {n}',
        'models.max.hint': '下一次请求的输出 token 上限，也是「思考预算」的大小：档位是上限、这里是尺寸。顶配取适配器为该模型报出的容量。',
        'models.temp': '温度',
        'models.temp.auto': '默认',
        'models.stop': '停止序列',
        'models.stop.hint': '一行一个，最多 8 条；只有部分通道会把它带上（responses 通道不带）。',
        'models.reset': '恢复默认',
        'models.remove': '移除规则',
        'models.ctx': '上下文 {n}',
        'models.out': '输出 {n}',
        'models.vision': '可读图',
        'models.unresolved': '能力未读到',
        'models.expand': '展开参数',
        'models.collapse': '收起',
        'models.top': '全部顶配',
        'models.top.hint': '把每个模型都拉到它能给的最高档位与最大输出上限，先预览再写入。',
        'models.ai': 'AI 智能填写',
        'models.ai.hint': '让一个模型按每个模型声明的能力填参数，结果显示在下面，确认后才写入。',
        'models.ai.route': '由 {route} 填写',
        'models.ai.bad': '这个模型没有返回可用的 JSON，没有写入任何东西。',
        'models.ai.raw': '原始回答',
        'models.proposal': '待应用的改动（{n} 项）',
        'models.proposal.apply': '应用 {n} 项',
        'models.proposal.cancel': '取消',
        'models.proposal.rejected': '{n} 项被拒绝：{why}',
        'models.applied': '已应用',
        'models.undo': '撤销上一次改动',
        'models.appliedCount': '本进程已按存储参数发出 {n} 次请求。',
        'models.foot': '参数在每次请求组装完成后写入（agent/request），所以改完立即对下一次请求生效，不用重启；点「恢复默认」会把这几个字段交还模型自己决定。',
        'models.saveFailed': '保存失败',
      },
      en: {
        nav: 'OFM Addition',
        title: 'OFM Addition',
        subtitle: 'An add-on for Our Free Model · auto-continue on truncation',
        master: 'Auto-continue',
        masterHint:
          'When a reply is cut off by the output-token cap, send "continue" for you so the model picks up where it stopped.',
        'state.on': 'On',
        'state.off': 'Off',

        'section.behavior': 'Continuation rules',
        'field.maxContinuations': 'Continuations per truncation',
        'hint.maxContinuations': 'How many times one truncation may be answered automatically. "Unlimited" keeps going until the context fills up.',
        'unlimited': 'Unlimited',
        'field.delayMs': 'Wait before sending',
        'hint.delayMs':
          'Leaves room for the stop button. Typing, stopping, or switching model during this window cancels the continuation.',
        'field.prompt': 'Prompt',
        'preset.explicit': 'Explicit',
        'preset.simple': 'Plain',
        'field.customPrompt': 'Custom prompt',
        'hint.customPrompt': 'Leave empty to use the preset above.',
        'preview': 'What will be sent',

        'field.contextGuard': 'Context guard',
        'hint.contextGuard':
          'Stand down once the next request would already sit near the routed model\'s context window. This is the only brake when the limit is unlimited.',
        'field.contextRatio': 'Stop at this point in the window',
        'hint.contextRatio':
          'The prompt budget is the window minus the output the request reserves, and this is the fraction of it. 100% means the literal limit; leaving headroom avoids the overflow error.',
        'warn.unbounded':
          'Unlimited with the context guard off: continuations run until the provider reports an overflow. Keep at least one of the two brakes.',
        'agent.overflowed': 'context full',

        'section.transcript': 'Transcript',
        'field.foldContinuations': 'Fold auto-continued parts',
        'hint.foldContinuations':
          'Take this plugin\'s own "continue" prompts and the truncation notices it already answered out of the transcript, so one continuous answer reads as one message. Click the count badge to reveal them.',
        'field.showContinueCount': 'Show the continuation count',
        'hint.showContinueCount':
          'When the task finishes or the context stops the run, annotate the last output\'s time with how many times it was continued.',
        'badge': '（auto-continued ×{n}）',
        'badge.title': 'This run was auto-continued {n} times and ended by "{ended}". Click to {state}.',
        'badge.reveal': 'reveal those rows',
        'badge.hide': 'fold them again',
        'badge.ends.completed': 'the task completing',
        'badge.ends.aborted': 'a stop',
        'badge.ends.error': 'an error',
        'badge.ends.blocked': 'a block',
        'badge.ends.unknown': 'the turn ending',
        'badge.ends.user-input': 'you taking over',
        'badge.ends.context-overflow': 'the context window',
        'folded.none': 'Nothing to fold in this run',

        'section.scope': 'Scope',
        'field.ofmOnly': 'Our Free Model only',
        'hint.ofmOnly':
          'This is an add-on for Our Free Model. While on, only its routes are touched and every other provider is left alone; turn it off to fall back to the allow-lists below.',
        'field.ofmProviders': 'Our Free Model routes',
        'hint.ofmProviders': 'One per line or comma separated; `*` wildcards are honored. Defaults to the main and region-limited routes.',
        'field.providers': 'Only these providers',
        'field.models': 'Only these models',
        'hint.scope': 'One per line or comma separated; `*` wildcards are honored (e.g. our-free-model*). Empty means all. Used only while "Our Free Model only" is off.',
        'field.includeSubagents': 'Continue subagents too',
        'hint.includeSubagents': 'Only the main conversation is handled by default; subagents are usually settled by their parent.',
        'field.skipOnTruncatedToolCall': 'Skip when the cut lands in a tool call',
        'hint.skipOnTruncatedToolCall':
          'When on, output truncated mid-arguments is left alone so you can decide what to do.',
        'field.messageMode': 'How it appears',
        'mode.user': 'User bubble',
        'mode.notice': 'Automation notice',
        'hint.messageMode':
          'User bubble reads exactly like you typing "continue". Automation notice marks the turn as plugin-triggered instead.',

        'section.status': 'Activity',
        'stat.sent': 'Sent',
        'stat.recent': 'Last 24h',
        'stat.budget': 'Budget spent',
        'stat.context': 'Context stops',
        'agents.title': 'Live sessions',
        'agents.empty': 'No session is being tracked right now.',
        'agents.armed': 'Armed',
        'agents.idle': 'Idle',
        'agents.running': 'Running',
        'agents.subagent': 'subagent',
        'agents.round': 'round {n}',
        'nudge': 'Continue now',
        'nudge.sent': 'Sent',
        'nudge.busy': 'That session is running; wait for it to stop.',
        'reset': 'Clear counters',
        'reset.done': 'Cleared',
        'history.title': 'Recent decisions',
        'history.empty': 'Nothing recorded yet.',
        'col.time': 'Time',
        'col.result': 'Result',
        'col.session': 'Session',
        'col.model': 'Model',

        'loading': 'Loading…',
        'backend': 'Cannot reach the plugin backend',
        'retry': 'Retry',
        'saved': 'Saved',
        'saveFailed': 'Save failed',

        'outcome.sent': 'Continuation sent',
        'outcome.disabled': 'Plugin is off',
        'outcome.no-pending': 'Nothing awaiting continuation',
        'outcome.agent-gone': 'Session is gone',
        'outcome.agent-busy': 'Session is running',
        'outcome.user-driving': 'You already queued input',
        'outcome.budget-spent': 'Continuation limit reached',
        'outcome.context-full': 'Context is nearly full',
        'outcome.context-overflow': 'Context overflowed; stopped',
        'outcome.route-filtered': 'Current model is out of scope',
        'outcome.subagent-filtered': 'Subagents are not continued',
        'outcome.tool-call-truncated': 'The cut landed in a tool call',
        'outcome.disposed': 'Plugin unloaded',

        'foot.rule': 'How it decides',
        'foot.ruleText':
          'Only a real output-token stop (finish_reason = length) triggers it — a normal finish, an error, or your own stop never does. Every condition is re-checked on the far side of the delay, so you always win.',
        'nav.models': 'OFM model parameters',
        'title.models': 'OFM model parameters',
        'subtitle.models': 'Every Our Free Model route · request parameters',
        'models.count': '{total} models · {set} configured',
        'models.list': 'Models',
        'models.refresh': 'Reload',
        'models.search': 'Search a model or route',
        'models.onlySet': 'Configured only',
        'models.scope': 'Scope',
        'models.scope.hint': 'One provider pattern per line, `*` wildcards honored — it decides which models this page lists. Parameters are only ever written to the models you configure here; every other route is left alone.',
        'models.empty': 'No model in this scope can be configured.',
        'models.state.untouched': 'Not configured',
        'models.state.defaults': 'Model defaults',
        'models.effort': 'Thinking rung',
        'models.effort.default': 'Model default',
        'models.effort.none': 'This model declares no thinking rungs, so no effort is sent; only the ceiling and sampling parameters apply here.',
        'models.effort.session': 'Session pick wins',
        'models.effort.session.hint': 'While on, a rung you pick in the model picker overrides this page; while off, this page is the authority.',
        'models.max': 'Output ceiling',
        'models.max.auto': 'Model default',
        'models.max.top': 'Max {n}',
        'models.max.hint': 'The output-token ceiling of the next request, and the size of the thinking budget: the rung is the level, this is the size. The maximum is the capacity the adapter reports for the model.',
        'models.temp': 'Temperature',
        'models.temp.auto': 'Default',
        'models.stop': 'Stop sequences',
        'models.stop.hint': 'One per line, at most 8; only some wires carry them (the responses wire does not).',
        'models.reset': 'Restore defaults',
        'models.remove': 'Remove the rule',
        'models.ctx': 'ctx {n}',
        'models.out': 'out {n}',
        'models.vision': 'sees images',
        'models.unresolved': 'capabilities unread',
        'models.expand': 'Show parameters',
        'models.collapse': 'Collapse',
        'models.top': 'Max everything',
        'models.top.hint': 'Raise every model to the highest rung and the largest ceiling it offers — previewed before anything is written.',
        'models.ai': 'Let a model fill it in',
        'models.ai.hint': 'Asks a model to fill parameters from each route declaration. The result is shown below and written only after you confirm.',
        'models.ai.route': 'filled by {route}',
        'models.ai.bad': 'That model returned no usable JSON, so nothing was written.',
        'models.ai.raw': 'Raw answer',
        'models.proposal': 'Pending changes ({n})',
        'models.proposal.apply': 'Apply {n}',
        'models.proposal.cancel': 'Cancel',
        'models.proposal.rejected': '{n} rejected: {why}',
        'models.applied': 'Applied',
        'models.undo': 'Undo the last change',
        'models.appliedCount': 'This process has carried stored parameters on {n} requests.',
        'models.foot': 'Parameters are written after each request is assembled (agent/request), so an edit reaches the very next request with no restart; restore defaults hands those fields back to the model.',
        'models.saveFailed': 'Save failed',
      },
    }

    /** Document language, which is what the shell sets when the user switches. */
    function languageTag() {
      const value = typeof document !== 'undefined' ? document.documentElement?.lang : ''
      return typeof value === 'string' && value.startsWith('zh') ? 'zh' : 'en'
    }

    /** Fallback translator, used when the shell exposes no locale service. */
    function localT(key, params) {
      const table = DICT[languageTag()] ?? DICT.en
      let text = table[key] ?? DICT.en[key] ?? key
      if (params) for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value))
      return text
    }

    // ── backend ───────────────────────────────────────────────────────────────
    const API = '/api/ofm-addition'

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, { ...options, redirect: 'error' })
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        payload = { error: text.slice(0, 200) }
      }
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    const post = (path, body) =>
      api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })

    // ── styles ────────────────────────────────────────────────────────────────
    const STYLE_ID = 'ofm-addition-settings-styles'

    const CSS = `
.ofa_root{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px}
.ofa_head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.ofa_headtext{flex:1 1 260px;min-width:0}
.ofa_title{font-size:16px;font-weight:700;letter-spacing:.2px}
.ofa_sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:4px;line-height:1.6}
.ofa_master{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.ofa_masterlabel{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ofa_card{border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ofa_cardhead{display:flex;align-items:baseline;gap:8px;padding:12px 14px 0}
.ofa_cardtitle{font-weight:600;font-size:13px}
.ofa_cardbody{padding:6px 14px 14px;display:flex;flex-direction:column}
.ofa_row{display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ofa_row:last-child{border-bottom:none;padding-bottom:2px}
.ofa_rowlabel{flex:0 0 148px;padding-top:2px}
.ofa_rowname{font-size:12.5px}
.ofa_rowhint{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.6;margin-top:3px}
.ofa_rowbody{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:8px}
.ofa_ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ofa_input{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:5px 9px;outline:none;min-width:0}
.ofa_input:focus{border-color:var(--dsw-alias-state-business-primary)}
.ofa_input.ofa_area{width:100%;min-height:60px;resize:vertical;line-height:1.6}
.ofa_num{width:74px;text-align:center}
.ofa_pills{display:inline-flex;gap:4px;flex-wrap:wrap}
.ofa_pill{border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;font:inherit;font-size:11.5px;padding:4px 9px;cursor:pointer;transition:all .12s}
.ofa_pill:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary)}
.ofa_pill[data-on="1"]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}
.ofa_pre{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:7px;padding:8px 10px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.ofa_grid{display:flex;gap:10px;flex-wrap:wrap}
.ofa_stat{flex:1 1 120px;min-width:110px;border:.5px solid var(--dsw-alias-border-l1);border-radius:9px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2)}
.ofa_statnum{font-size:20px;font-weight:700;line-height:1.2}
.ofa_statlabel{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:3px}
.ofa_table{width:100%;border-collapse:collapse;font-size:11.5px}
.ofa_table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary);padding:6px 8px 6px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);white-space:nowrap}
.ofa_table td{padding:6px 8px 6px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);vertical-align:top}
.ofa_table tr:last-child td{border-bottom:none}
.ofa_mono{font-family:var(--dsw-font-markdown-code-block-small,ui-monospace,Menlo,Consolas,monospace)}
.ofa_tag{display:inline-flex;align-items:center;gap:5px;border-radius:20px;padding:2px 8px;font-size:11px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ofa_dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
.ofa_dot[data-state="armed"]{color:var(--dsw-alias-state-warning-primary)}
.ofa_dot[data-state="running"]{color:var(--dsw-alias-state-business-primary)}
.ofa_dot[data-state="idle"]{color:var(--dsw-alias-state-success-primary)}
.ofa_btn{border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:7px;font:inherit;font-size:12px;padding:5px 12px;cursor:pointer}
.ofa_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}
.ofa_btn:disabled{opacity:.45;cursor:default}
.ofa_link{border:none;background:none;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:11.5px;padding:0;cursor:pointer;text-decoration:underline}
.ofa_note{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.7}
.ofa_warn{font-size:11.5px;line-height:1.7;color:var(--dsw-alias-state-warning-primary);border-left:2px solid var(--dsw-alias-state-warning-primary);padding:2px 0 2px 8px}
.ofa_err{color:var(--dsw-alias-state-error-primary);font-size:12px}
.ofa_sw{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.ofa_swtrack{width:34px;height:19px;border-radius:19px;background:var(--dsw-alias-border-l2);position:relative;transition:background .15s;flex:0 0 auto}
.ofa_swtrack[data-on="1"]{background:var(--dsw-alias-state-business-primary)}
.ofa_swknob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:transform .15s}
.ofa_swtrack[data-on="1"] .ofa_swknob{transform:translateX(15px)}
.ofa_sw:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:6px}
.ofa_foot{border:.5px dashed var(--dsw-alias-border-l2);border-radius:9px;padding:10px 12px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.75}
.ofa_foot b{color:var(--dsw-alias-label-secondary);font-weight:600}
.ofa_toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0 2px}
.ofa_search{flex:1 1 200px;min-width:150px}
.ofa_mgroup{padding:0 0 4px}
.ofa_mgroupname{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.3px;padding:10px 0 4px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ofa_mrow{border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ofa_mrow:last-child{border-bottom:none}
.ofa_mhead{display:flex;align-items:flex-start;gap:8px;padding:8px 0;flex-wrap:wrap}
.ofa_mtoggle{border:none;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;cursor:pointer;padding:2px 2px 0}
.ofa_mtoggle:hover{color:var(--dsw-alias-label-primary)}
.ofa_mtext{flex:1 1 200px;min-width:0}
.ofa_mname{font-size:12.5px}
.ofa_mkey{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all;margin-top:2px;font-family:var(--dsw-font-markdown-code-block-small,ui-monospace,Menlo,Consolas,monospace)}
.ofa_mtags{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.ofa_tag[data-set="1"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.ofa_mbody{padding:2px 0 12px 20px;display:flex;flex-direction:column;gap:8px}
.ofa_mlabel{flex:0 0 74px;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding-top:4px}
.ofa_mctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ofa_draft{border:.5px solid var(--dsw-alias-state-business-primary);border-radius:9px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-2)}
.ofa_drafthead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ofa_draftrow{display:flex;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ofa_draftkey{flex:0 0 210px;min-width:0;word-break:break-all;color:var(--dsw-alias-label-tertiary)}
.ofa_draftval{flex:1 1 auto;min-width:0}
@media (max-width:760px){.ofa_row{flex-direction:column;gap:6px}.ofa_rowlabel{flex:0 0 auto}.ofa_mtags{justify-content:flex-start}.ofa_mlabel{flex:0 0 auto}.ofa_draftkey{flex:0 0 120px}}
`

    function installStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ── transcript: fold a run away, count it at the end ─────────────────────
    //
    // The chat renders every model-visible input as a row and offers no seam
    // that says "hide this one" — node kinds are shared with other features, so
    // replacing a renderer would hijack rows this plugin does not own. What the
    // chat does publish is a stable identity per row:
    //
    //   data-chat-node-key = `${kind.length}:${kind}${id}`, where `id` is the
    //   definition's business identity — for a message, the durable message id
    //   this plugin minted itself.
    //
    // So folding tags rows and lets a stylesheet hide them. Only an attribute is
    // written; React keeps owning every node it rendered, and switching the fold
    // off restores the shipped transcript exactly.
    const TRANSCRIPT_STYLE_ID = 'ofm-addition-transcript-styles'
    const FOLD_ATTR = 'data-ofa-folded'

    const TRANSCRIPT_CSS = `
[${FOLD_ATTR}]{display:none!important}
.ofa_count{order:9;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary);white-space:nowrap;cursor:pointer;user-select:none;padding:0 2px;border-radius:4px}
.ofa_count:hover{color:var(--dsw-alias-label-secondary)}
.ofa_count[data-revealed="1"]{color:var(--dsw-alias-state-business-primary)}
`

    function installTranscriptStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(TRANSCRIPT_STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = TRANSCRIPT_STYLE_ID
      style.textContent = TRANSCRIPT_CSS
      document.head.appendChild(style)
    }

    /**
     * Whether one transcript row belongs to an auto-continued run.
     *
     * Two rules with different identities: this plugin's own input rows carry
     * the message id inside the row key, while the truncation notices it already
     * answered are recognized by the turn they closed.
     */
    function rowIsFolded(row, index) {
      const key = row.getAttribute('data-chat-node-key') ?? row.getAttribute('data-chat-flow-key') ?? ''
      if (key !== '') {
        for (const id of index?.ids ?? []) {
          if (id !== '' && key.includes(id)) return true
        }
      }
      if (row.getAttribute('data-chat-flow-kind') !== 'turn-max-tokens') return false
      const turn = Number(row.getAttribute('data-chat-turn'))
      return Number.isFinite(turn) && (index?.turns ?? []).includes(turn)
    }

    function foldableRows(root) {
      return root?.querySelectorAll?.('[data-chat-node-key]') ?? []
    }

    /** Idempotent: the attribute lands where a run owns the row, nowhere else. */
    function applyFold(root, index, revealed) {
      if (root === undefined || root === null) return 0
      let folded = 0
      for (const row of foldableRows(root)) {
        const fold = revealed !== true && rowIsFolded(row, index)
        if (fold) {
          row.setAttribute(FOLD_ATTR, '')
          folded += 1
        } else {
          row.removeAttribute(FOLD_ATTR)
        }
      }
      return folded
    }

    function clearFold(root) {
      for (const row of foldableRows(root)) row.removeAttribute(FOLD_ATTR)
    }

    /** The transcript column this element rendered into, or the document. */
    function transcriptRoot(el) {
      let node = el?.parentElement ?? null
      let found = null
      while (node !== null && node !== undefined) {
        if (node.hasAttribute?.('data-chat-flow') === true) found = node
        node = node.parentElement ?? null
      }
      return found ?? el?.ownerDocument ?? null
    }

    // ── the report store: one fetch per session, shared by every row ─────────
    const transcriptStore = { reports: new Map(), revealed: new Map(), subscribers: new Map(), listeners: new Set(), pending: new Set() }
    let pollTimer = null

    function notifyTranscript() {
      for (const listener of [...transcriptStore.listeners]) listener()
    }

    async function refreshReport(sessionId) {
      if (sessionId === undefined || sessionId === null || sessionId === '') return
      // One row per finalized assistant message asks for the same report; the
      // first one in flight answers all of them.
      if (transcriptStore.pending.has(sessionId)) return
      transcriptStore.pending.add(sessionId)
      try {
        transcriptStore.reports.set(sessionId, await api(`/report?sessionId=${encodeURIComponent(sessionId)}`))
      } catch {
        // A backend that is not there yet must not fold anything, ever.
        transcriptStore.reports.set(sessionId, { scoped: false })
      } finally {
        transcriptStore.pending.delete(sessionId)
      }
      notifyTranscript()
    }

    function retainReport(sessionId) {
      const count = (transcriptStore.subscribers.get(sessionId) ?? 0) + 1
      transcriptStore.subscribers.set(sessionId, count)
      if (pollTimer !== null) return
      pollTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
        for (const id of transcriptStore.subscribers.keys()) void refreshReport(id)
      }, 5000)
    }

    function releaseReport(sessionId) {
      const count = (transcriptStore.subscribers.get(sessionId) ?? 0) - 1
      if (count > 0) transcriptStore.subscribers.set(sessionId, count)
      else transcriptStore.subscribers.delete(sessionId)
    }

    function refreshAllReports() {
      for (const id of transcriptStore.subscribers.keys()) void refreshReport(id)
    }

    /** Subscribe one component to a session's report and reveal state. */
    function useTranscript(sessionId) {
      const [, setTick] = useState(0)
      useEffect(() => {
        const listener = () => setTick((value) => value + 1)
        transcriptStore.listeners.add(listener)
        retainReport(sessionId)
        void refreshReport(sessionId)
        return () => {
          transcriptStore.listeners.delete(listener)
          releaseReport(sessionId)
        }
      }, [sessionId])
      return {
        report: sessionId === undefined ? null : transcriptStore.reports.get(sessionId) ?? null,
        revealed: transcriptStore.revealed.get(sessionId) === true,
        toggleRevealed: () => {
          transcriptStore.revealed.set(sessionId, transcriptStore.revealed.get(sessionId) !== true)
          notifyTranscript()
        },
      }
    }

    // One fold pass per session, refcounted over the components that want it.
    const foldHosts = new Map()

    function acquireFold(sessionId, root, readIndex) {
      const existing = foldHosts.get(sessionId)
      if (existing !== undefined && existing.root === root) {
        existing.count += 1
        return existing.release
      }
      let count = 1
      let observer = null
      let scheduled = false
      const pass = () => {
        scheduled = false
        if (foldHosts.get(sessionId) !== host) return
        applyFold(root, readIndex(), transcriptStore.revealed.get(sessionId) === true)
      }
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        queueMicrotask(pass)
      }
      const host = { root, count }
      if (typeof MutationObserver === 'function' && root !== null && root !== undefined) {
        observer = new MutationObserver(schedule)
        observer.observe(root, { childList: true, subtree: true })
      }
      const release = () => {
        observer?.disconnect()
        clearFold(root)
        if (foldHosts.get(sessionId) === host) foldHosts.delete(sessionId)
      }
      host.release = release
      foldHosts.set(sessionId, host)
      schedule()
      return release
    }

    /**
     * The count badge, rendered inside one finalized assistant message's action
     * row. It also owns the session's fold pass, because this is the only seat
     * that is both per-session and always mounted once a turn has completed.
     */
    function ContinueCountAction(props) {
      const t = typeof props?.t === 'function' ? props.t : localT
      const sessionId = props?.sessionId
      const anchorRef = useRef(null)
      const { report, revealed, toggleRevealed } = useTranscript(sessionId)
      const inScope = report !== null && report.scoped === true

      const index = useMemo(
        () => ({ ids: inScope ? report.ids ?? [] : [], turns: inScope ? report.turns ?? [] : [] }),
        [inScope, report],
      )

      useEffect(() => {
        const el = anchorRef.current
        if (el === null || el === undefined || inScope !== true) return undefined
        const root = transcriptRoot(el)
        if (root === null || root === undefined) return undefined
        return acquireFold(sessionId, root, () => index)
      }, [sessionId, inScope, index])

      if (inScope !== true || report.annotate !== true) return null
      const final = (report.finals ?? []).find((row) => row.messageId === props?.messageId)
      if (final === undefined) return null
      const ended = t(`badge.ends.${final.endedBy ?? 'unknown'}`)
      return h(
        'span',
        { ref: anchorRef, style: { display: 'contents' } },
        h(
          'span',
          {
            className: 'ofa_count',
            'data-revealed': revealed ? '1' : '0',
            role: 'button',
            tabIndex: 0,
            title: t('badge.title', { n: final.count, ended, state: revealed ? t('badge.hide') : t('badge.reveal') }),
            onClick: toggleRevealed,
            onKeyDown: (event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault()
                toggleRevealed()
              }
            },
          },
          t('badge', { n: final.count }),
        ),
      )
    }


    // ── small controls ────────────────────────────────────────────────────────
    function Switch({ checked, onChange, label }) {
      return h(
        'span',
        {
          className: 'ofa_sw',
          role: 'switch',
          tabIndex: 0,
          'aria-checked': checked ? 'true' : 'false',
          onClick: () => onChange(!checked),
          onKeyDown: (event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault()
              onChange(!checked)
            }
          },
        },
        h('span', { className: 'ofa_swtrack', 'data-on': checked ? '1' : '0' }, h('span', { className: 'ofa_swknob' })),
        label === undefined ? null : h('span', { style: { fontSize: '12px' } }, label),
      )
    }

    function Pills({ value, options, onChange }) {
      return h(
        'span',
        { className: 'ofa_pills' },
        options.map((option) =>
          h(
            'button',
            {
              key: String(option.value),
              type: 'button',
              className: 'ofa_pill',
              'data-on': String(option.value) === String(value) ? '1' : '0',
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      )
    }

    /**
     * A text/number field that commits on blur or Enter, so a half-typed number
     * never reaches the host and never re-renders the field out from under the
     * caret.
     */
    function CommittedInput({ value, onCommit, numeric = false, multiline = false, placeholder, className }) {
      const [draft, setDraft] = useState(String(value ?? ''))
      const editing = useRef(false)
      useEffect(() => {
        if (!editing.current) setDraft(String(value ?? ''))
      }, [value])
      const commit = () => {
        editing.current = false
        if (draft === String(value ?? '')) return
        onCommit(numeric ? Number(draft) : draft)
      }
      const shared = {
        className: `ofa_input ${className ?? ''}`,
        spellCheck: false,
        value: draft,
        placeholder,
        onFocus: () => {
          editing.current = true
        },
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
      }
      if (multiline) return h('textarea', { ...shared, rows: 3, className: `${shared.className} ofa_area` })
      return h('input', {
        ...shared,
        type: numeric ? 'number' : 'text',
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        },
      })
    }

    function Row({ name, hint, children }) {
      return h(
        'div',
        { className: 'ofa_row' },
        h('div', { className: 'ofa_rowlabel' }, h('div', { className: 'ofa_rowname' }, name), hint ? h('div', { className: 'ofa_rowhint' }, hint) : null),
        h('div', { className: 'ofa_rowbody' }, children),
      )
    }

    function Card({ title, children }) {
      return h(
        'section',
        { className: 'ofa_card' },
        h('div', { className: 'ofa_cardhead' }, h('div', { className: 'ofa_cardtitle' }, title)),
        h('div', { className: 'ofa_cardbody' }, children),
      )
    }

    function timeText(at) {
      if (!at) return '—'
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    // ── the section ───────────────────────────────────────────────────────────
    function SettingsSection(props) {
      const t = props?.t ?? localT
      const [data, setData] = useState(undefined)
      const [error, setError] = useState('')
      const [flash, setFlash] = useState('')
      const [busy, setBusy] = useState('')

      const refresh = useCallback(async () => {
        try {
          const next = await api('/summary')
          setData(next)
          setError('')
          return next
        } catch (problem) {
          setError(String(problem?.message ?? problem))
          return undefined
        }
      }, [])

      useEffect(() => {
        void refresh()
        // The host half owns the truth (a continuation can land at any moment),
        // so the page polls while it is the visible one.
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
          void refresh()
        }, 4000)
        return () => clearInterval(timer)
      }, [refresh])

      const save = useCallback(async (patch) => {
        setBusy('save')
        try {
          const result = await post('/settings', patch)
          setData((current) => (current === undefined ? current : { ...current, settings: result.settings }))
          // A scope or presentation change re-shapes the transcript immediately.
          refreshAllReports()
          setFlash(t('saved'))
          window.setTimeout(() => setFlash(''), 1400)
        } catch (problem) {
          setFlash(`${t('saveFailed')}: ${String(problem?.message ?? problem)}`)
        } finally {
          setBusy('')
        }
      }, [t])

      if (error !== '' && data === undefined) {
        return h(
          'div',
          { className: 'ofa_root' },
          h('div', { className: 'ofa_title' }, t('title')),
          h('div', { className: 'ofa_err' }, `${t('backend')} · ${error}`),
          h('div', null, h('button', { type: 'button', className: 'ofa_btn', onClick: () => void refresh() }, t('retry'))),
        )
      }
      if (data === undefined) return h('div', { className: 'ofa_root' }, h('div', { className: 'ofa_note' }, t('loading')))

      const settings = data.settings
      const stats = data.stats ?? {}
      const history = Array.isArray(stats.history) ? stats.history : []
      const agents = Array.isArray(data.agents) ? data.agents : []
      const dayAgo = Date.now() - 24 * 3600 * 1000
      const recent = history.filter((row) => row.at >= dayAgo)
      const recentSent = recent.filter((row) => row.outcome === 'sent').length
      const budgetSpent = stats.outcomes?.['budget-spent'] ?? 0
      const contextStops = (stats.outcomes?.['context-full'] ?? 0) + (stats.outcomes?.['context-overflow'] ?? 0)
      const vocabulary = data.vocabulary ?? {}

      const presetOptions = (vocabulary.prompts ?? ['explicit', 'simple']).map((key) => ({ value: key, label: t(`preset.${key}`) }))

      return h(
        Fragment,
        null,
        h(
          'div',
          { className: 'ofa_root' },
          h(
            'div',
            { className: 'ofa_head' },
            h(
              'div',
              { className: 'ofa_headtext' },
              h('div', { className: 'ofa_title' }, t('title')),
              h('div', { className: 'ofa_sub' }, `${t('subtitle')} · v${data.version}`),
            ),
            h(
              'div',
              { className: 'ofa_master' },
              h('span', { className: 'ofa_masterlabel' }, settings.enabled ? t('state.on') : t('state.off')),
              h(Switch, { checked: settings.enabled, onChange: (value) => void save({ enabled: value }) }),
            ),
          ),

          h(
            Card,
            { title: t('section.behavior') },
            h(
              Row,
              { name: t('field.maxContinuations'), hint: t('hint.maxContinuations') },
              h(
                'div',
                { className: 'ofa_ctl' },
                h(CommittedInput, {
                  value: settings.maxContinuations,
                  numeric: true,
                  className: 'ofa_num',
                  onCommit: (value) => void save({ maxContinuations: value }),
                }),
                h(Pills, {
                  value: settings.maxContinuations,
                  // 0 is the host's documented "no ceiling", so the pills carry
                  // both ends of the choice rather than only numbers.
                  options: [
                    { value: 0, label: `∞ ${t('unlimited')}` },
                    ...[1, 3, 5, 10].map((value) => ({ value, label: String(value) })),
                  ],
                  onChange: (value) => void save({ maxContinuations: value }),
                }),
              ),
              settings.unbounded === true && settings.contextGuard !== true
                ? h('div', { className: 'ofa_warn' }, t('warn.unbounded'))
                : null,
            ),
            h(
              Row,
              { name: t('field.contextGuard'), hint: t('hint.contextGuard') },
              h(Switch, { checked: settings.contextGuard, onChange: (value) => void save({ contextGuard: value }) }),
              settings.contextGuard === true
                ? h(Pills, {
                    value: settings.contextRatio,
                    options: [0.8, 0.9, 0.95, 1].map((value) => ({ value, label: `${Math.round(value * 100)}%` })),
                    onChange: (value) => void save({ contextRatio: value }),
                  })
                : null,
              settings.contextGuard === true
                ? h('div', { className: 'ofa_note' }, t('hint.contextRatio'))
                : null,
            ),
            h(
              Row,
              { name: t('field.delayMs'), hint: t('hint.delayMs') },
              h(Pills, {
                value: settings.delayMs,
                options: [
                  { value: 0, label: '0s' },
                  { value: 350, label: '0.35s' },
                  { value: 1000, label: '1s' },
                  { value: 3000, label: '3s' },
                ],
                onChange: (value) => void save({ delayMs: value }),
              }),
            ),
            h(
              Row,
              { name: t('field.prompt'), hint: t('hint.customPrompt') },
              h(Pills, {
                value: settings.promptPreset,
                options: presetOptions,
                onChange: (value) => void save({ promptPreset: value }),
              }),
              h(CommittedInput, {
                value: settings.prompt,
                multiline: true,
                placeholder: settings.effectivePrompt,
                onCommit: (value) => void save({ prompt: value }),
              }),
            ),
            h(
              Row,
              { name: t('preview') },
              h('div', { className: 'ofa_pre' }, settings.effectivePrompt),
            ),
          ),

          h(
            Card,
            { title: t('section.transcript') },
            h(
              Row,
              { name: t('field.foldContinuations'), hint: t('hint.foldContinuations') },
              h(Switch, { checked: settings.foldContinuations, onChange: (value) => void save({ foldContinuations: value }) }),
            ),
            h(
              Row,
              { name: t('field.showContinueCount'), hint: t('hint.showContinueCount') },
              h(Switch, { checked: settings.showContinueCount, onChange: (value) => void save({ showContinueCount: value }) }),
            ),
          ),

          h(
            Card,
            { title: t('section.scope') },
            h(
              Row,
              { name: t('field.ofmOnly'), hint: t('hint.ofmOnly') },
              h(Switch, { checked: settings.ofmOnly, onChange: (value) => void save({ ofmOnly: value }) }),
              settings.ofmOnly === true
                ? h(CommittedInput, {
                    value: (settings.ofmProviders ?? []).join('\n'),
                    multiline: true,
                    placeholder: 'our-free-model*',
                    onCommit: (value) => void save({ ofmProviders: value }),
                  })
                : null,
            ),
            settings.ofmOnly === true ? null : h(
              Row,
              { name: t('field.providers'), hint: t('hint.scope') },
              h(CommittedInput, {
                value: (settings.providers ?? []).join('\n'),
                multiline: true,
                placeholder: 'our-free-model*',
                onCommit: (value) => void save({ providers: value }),
              }),
            ),
            settings.ofmOnly === true ? null : h(
              Row,
              { name: t('field.models'), hint: t('hint.scope') },
              h(CommittedInput, {
                value: (settings.models ?? []).join('\n'),
                multiline: true,
                placeholder: '*',
                onCommit: (value) => void save({ models: value }),
              }),
            ),
            h(
              Row,
              { name: t('field.messageMode'), hint: t('hint.messageMode') },
              h(Pills, {
                value: settings.messageMode,
                options: [
                  { value: 'user', label: t('mode.user') },
                  { value: 'notice', label: t('mode.notice') },
                ],
                onChange: (value) => void save({ messageMode: value }),
              }),
            ),
            h(
              Row,
              { name: t('field.includeSubagents'), hint: t('hint.includeSubagents') },
              h(Switch, { checked: settings.includeSubagents, onChange: (value) => void save({ includeSubagents: value }) }),
            ),
            h(
              Row,
              { name: t('field.skipOnTruncatedToolCall'), hint: t('hint.skipOnTruncatedToolCall') },
              h(Switch, {
                checked: settings.skipOnTruncatedToolCall,
                onChange: (value) => void save({ skipOnTruncatedToolCall: value }),
              }),
            ),
          ),

          h(
            Card,
            { title: t('section.status') },
            h(
              'div',
              { className: 'ofa_grid', style: { padding: '8px 0 12px' } },
              h('div', { className: 'ofa_stat' }, h('div', { className: 'ofa_statnum' }, String(stats.sent ?? 0)), h('div', { className: 'ofa_statlabel' }, t('stat.sent'))),
              h('div', { className: 'ofa_stat' }, h('div', { className: 'ofa_statnum' }, String(recentSent)), h('div', { className: 'ofa_statlabel' }, t('stat.recent'))),
              h('div', { className: 'ofa_stat' }, h('div', { className: 'ofa_statnum' }, String(budgetSpent)), h('div', { className: 'ofa_statlabel' }, t('stat.budget'))),
              h('div', { className: 'ofa_stat' }, h('div', { className: 'ofa_statnum' }, String(contextStops)), h('div', { className: 'ofa_statlabel' }, t('stat.context'))),
            ),
            h('div', { className: 'ofa_cardtitle', style: { paddingBottom: '6px' } }, t('agents.title')),
            agents.length === 0
              ? h('div', { className: 'ofa_note' }, t('agents.empty'))
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '6px', paddingBottom: '8px' } },
                  agents.map((agent) =>
                    h(
                      'div',
                      { key: agent.sessionId, style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                      h(
                        'span',
                        { className: 'ofa_tag' },
                        h('span', { className: 'ofa_dot', 'data-state': agent.armed ? 'armed' : agent.status === 'running' ? 'running' : 'idle' }),
                        agent.armed ? t('agents.armed') : agent.status === 'running' ? t('agents.running') : t('agents.idle'),
                      ),
                      h('span', { className: 'ofa_mono', style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' } },
                        `${agent.provider || '—'}/${agent.model || '—'}`),
                      agent.subagent ? h('span', { className: 'ofa_tag' }, t('agents.subagent')) : null,
                      agent.overflowed ? h('span', { className: 'ofa_tag' }, t('agent.overflowed')) : null,
                      agent.lastOutcome && agent.lastOutcome !== 'sent'
                        ? h('span', { className: 'ofa_tag' }, t(`outcome.${agent.lastOutcome}`))
                        : null,
                      agent.streak > 0 ? h('span', { className: 'ofa_tag' }, t('agents.round', { n: agent.streak })) : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'ofa_link',
                          disabled: agent.status !== 'idle',
                          onClick: async () => {
                            setBusy(agent.sessionId)
                            try {
                              const result = await post('/nudge', { sessionId: agent.sessionId })
                              setFlash(result.ok ? t('nudge.sent') : t(`outcome.${result.outcome}`))
                              await refresh()
                            } catch (problem) {
                              setFlash(String(problem?.message ?? problem))
                            } finally {
                              setBusy('')
                            }
                          },
                        },
                        busy === agent.sessionId ? '…' : t('nudge'),
                      ),
                    ),
                  ),
                ),
            h('div', { className: 'ofa_cardtitle', style: { paddingBottom: '2px' } }, t('history.title')),
            history.length === 0
              ? h('div', { className: 'ofa_note' }, t('history.empty'))
              : h(
                  'table',
                  { className: 'ofa_table' },
                  h('thead', null, h('tr', null,
                    h('th', null, t('col.time')),
                    h('th', null, t('col.result')),
                    h('th', null, t('col.session')),
                    h('th', null, t('col.model')),
                  )),
                  h('tbody', null, history.slice(0, 12).map((row, index) =>
                    h('tr', { key: `${row.at}-${index}` },
                      h('td', { className: 'ofa_mono' }, timeText(row.at)),
                      h('td', { style: { color: row.outcome === 'sent' ? 'var(--dsw-alias-state-success-primary)' : undefined } },
                        t(`outcome.${row.outcome}`)),
                      h('td', { className: 'ofa_mono' }, row.sessionId ? row.sessionId.slice(0, 12) : '—'),
                      h('td', { className: 'ofa_mono' }, row.model || '—'),
                    ),
                  )),
                ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '10px' } },
              h('button', {
                type: 'button',
                className: 'ofa_btn',
                disabled: busy !== '',
                onClick: async () => {
                  setBusy('reset')
                  try {
                    await post('/reset')
                    await refresh()
                    setFlash(t('reset.done'))
                  } finally {
                    setBusy('')
                  }
                },
              }, t('reset')),
              flash === '' ? null : h('span', { className: 'ofa_note' }, flash),
            ),
          ),

          h('div', { className: 'ofa_foot' }, h('b', null, t('foot.rule')), ' ', t('foot.ruleText')),
        ),
      )
    }

    // ── the per-model parameter page ────────────────────────────────────────
    //
    // One row per route. Everything shown comes from `GET /models`, which
    // resolves each model's declared capabilities live, so a rung a provider no
    // longer offers cannot be saved here — and is declined again at the wire.

    /** `16384` -> `16 K`, the spelling the model picker and the README use. */
    function kilos(value) {
      const tokens = Number(value)
      if (!Number.isFinite(tokens) || tokens <= 0) return '—'
      if (tokens >= 1048576) {
        const millions = tokens / 1048576
        return `${Number.isInteger(millions) ? millions : millions.toFixed(1)} M`
      }
      return `${Math.round(tokens / 1024)} K`
    }

    /** An entry that asks for nothing; the state a row restores defaults with. */
    function blankEntry() {
      return { enabled: true, effort: '', effortMode: 'preset', maxTokens: null, temperature: null, stop: [], note: '' }
    }

    /** One row's stored parameters as a single line of text. */
    function entrySummary(entry, t) {
      if (entry === null || entry === undefined) return t('models.state.untouched')
      const parts = []
      if (typeof entry.effort === 'string' && entry.effort !== '') parts.push(entry.effort)
      if (entry.maxTokens !== null && entry.maxTokens !== undefined) parts.push(`≤${kilos(entry.maxTokens)}`)
      if (entry.temperature !== null && entry.temperature !== undefined) parts.push(`T=${entry.temperature}`)
      if (Array.isArray(entry.stop) && entry.stop.length > 0) parts.push(`stop×${entry.stop.length}`)
      if (parts.length === 0) return t('models.state.defaults')
      if (entry.effortMode === 'session') parts.push(t('models.effort.session'))
      return parts.join(' · ')
    }

    /** Which rows the search box and the configured-only switch leave visible. */
    function visibleModels(models, query, onlySet) {
      const needle = String(query ?? '').trim().toLowerCase()
      return (Array.isArray(models) ? models : []).filter((row) => {
        if (onlySet === true && (row.entry === null || row.entry === undefined)) return false
        if (needle === '') return true
        return `${row.name} ${row.key} ${row.provider}`.toLowerCase().includes(needle)
      })
    }

    /** Group rows by provider, keeping the order the host sorted them into. */
    function groupByProvider(rows) {
      const groups = []
      for (const row of rows) {
        const last = groups[groups.length - 1]
        if (last !== undefined && last.provider === row.provider) last.rows.push(row)
        else groups.push({ provider: row.provider, rows: [row] })
      }
      return groups
    }

    /** How a stored ceiling reads in the pills: default, the advertised max, or yours. */
    function maxTokenChoice(entry, row) {
      const value = entry?.maxTokens
      if (value === null || value === undefined) return 'auto'
      if (Number.isFinite(row.defaultMaxTokens) && value === row.defaultMaxTokens) return 'top'
      return 'custom'
    }

    function ModelRow(props) {
      const { row, t, entry, open, busy, onToggle, onSave, onReset, onRemove } = props
      const efforts = Array.isArray(row.efforts) ? row.efforts : []
      const stopText = Array.isArray(entry?.stop) ? entry.stop.join('\n') : ''
      const temperature = entry?.temperature
      return h(
        'div',
        { className: 'ofa_mrow' },
        h(
          'div',
          { className: 'ofa_mhead' },
          h(
            'button',
            {
              type: 'button',
              className: 'ofa_mtoggle',
              'aria-expanded': open ? 'true' : 'false',
              title: open ? t('models.collapse') : t('models.expand'),
              onClick: onToggle,
            },
            open ? '▾' : '▸',
          ),
          h(
            'div',
            { className: 'ofa_mtext' },
            h('div', { className: 'ofa_mname' }, row.name),
            h('div', { className: 'ofa_mkey' }, row.key),
          ),
          h(
            'div',
            { className: 'ofa_mtags' },
            Number.isFinite(row.contextWindow) ? h('span', { className: 'ofa_tag' }, t('models.ctx', { n: kilos(row.contextWindow) })) : null,
            Number.isFinite(row.defaultMaxTokens) ? h('span', { className: 'ofa_tag' }, t('models.out', { n: kilos(row.defaultMaxTokens) })) : null,
            row.vision === true ? h('span', { className: 'ofa_tag' }, t('models.vision')) : null,
            row.resolved !== true ? h('span', { className: 'ofa_tag' }, t('models.unresolved')) : null,
            h('span', { className: 'ofa_tag', 'data-set': entry === null || entry === undefined ? '0' : '1' }, entrySummary(entry, t)),
          ),
        ),
        open !== true
          ? null
          : h(
              'div',
              { className: 'ofa_mbody' },
              h(
                'div',
                { className: 'ofa_mctl' },
                h('span', { className: 'ofa_mlabel' }, t('models.effort')),
                h(Pills, {
                  value: entry?.effort ?? '',
                  options: [
                    { value: '', label: t('models.effort.default') },
                    ...efforts.map((effort) => ({ value: effort.id, label: effort.name })),
                  ],
                  onChange: (value) => onSave({ effort: value }),
                }),
              ),
              efforts.length === 0 ? h('div', { className: 'ofa_note' }, t('models.effort.none')) : null,
              efforts.length === 0
                ? null
                : h(
                    'div',
                    { className: 'ofa_mctl' },
                    h('span', { className: 'ofa_mlabel' }, ''),
                    h(Switch, {
                      checked: entry?.effortMode === 'session',
                      label: t('models.effort.session'),
                      onChange: (value) => onSave({ effortMode: value ? 'session' : 'preset' }),
                    }),
                    h('span', { className: 'ofa_note' }, t('models.effort.session.hint')),
                  ),
              h(
                'div',
                { className: 'ofa_mctl' },
                h('span', { className: 'ofa_mlabel' }, t('models.max')),
                h(CommittedInput, {
                  value: entry?.maxTokens ?? '',
                  numeric: true,
                  className: 'ofa_num',
                  onCommit: (value) => onSave({ maxTokens: Number(value) > 0 ? Math.trunc(Number(value)) : null }),
                }),
                h(Pills, {
                  value: maxTokenChoice(entry, row),
                  options: [
                    { value: 'auto', label: t('models.max.auto') },
                    ...(Number.isFinite(row.defaultMaxTokens)
                      ? [{ value: 'top', label: t('models.max.top', { n: kilos(row.defaultMaxTokens) }) }]
                      : []),
                  ],
                  onChange: (value) => onSave({ maxTokens: value === 'top' ? row.defaultMaxTokens : null }),
                }),
              ),
              h('div', { className: 'ofa_note' }, t('models.max.hint')),
              h(
                'div',
                { className: 'ofa_mctl' },
                h('span', { className: 'ofa_mlabel' }, t('models.temp')),
                h(CommittedInput, {
                  value: temperature ?? '',
                  numeric: true,
                  className: 'ofa_num',
                  onCommit: (value) => onSave({ temperature: String(value).trim() === '' ? null : Number(value) }),
                }),
                h(Pills, {
                  value: temperature === null || temperature === undefined ? 'auto' : 'custom',
                  options: [{ value: 'auto', label: t('models.temp.auto') }],
                  onChange: () => onSave({ temperature: null }),
                }),
              ),
              h(
                'div',
                { className: 'ofa_mctl' },
                h('span', { className: 'ofa_mlabel' }, t('models.stop')),
                h(CommittedInput, {
                  value: stopText,
                  multiline: true,
                  onCommit: (value) => onSave({ stop: String(value).split(/\r?\n/) }),
                }),
              ),
              h('div', { className: 'ofa_note' }, t('models.stop.hint')),
              h(
                'div',
                { className: 'ofa_mctl' },
                h('button', { type: 'button', className: 'ofa_btn', disabled: busy, onClick: onReset }, t('models.reset')),
                h('button', { type: 'button', className: 'ofa_link', disabled: busy, onClick: onRemove }, t('models.remove')),
              ),
            ),
      )
    }

    function ModelsSection(props) {
      const t = props?.t ?? localT
      const [data, setData] = useState(undefined)
      const [error, setError] = useState('')
      const [flash, setFlash] = useState('')
      const [busy, setBusy] = useState('')
      const [draft, setDraft] = useState(null)
      const [query, setQuery] = useState('')
      const [onlySet, setOnlySet] = useState(false)
      const [open, setOpen] = useState('')
      const [scopeDraft, setScopeDraft] = useState('')

      const flashFor = (text) => {
        setFlash(text)
        window.setTimeout(() => setFlash(''), 1600)
      }

      const refresh = useCallback(async () => {
        try {
          const next = await api('/models')
          setData(next)
          setScopeDraft((next.scope ?? []).join('\n'))
          setError('')
          return next
        } catch (problem) {
          setError(String(problem?.message ?? problem))
          return undefined
        }
      }, [])

      useEffect(() => {
        void refresh()
        // The stored table is the host's, and a second window may be editing it;
        // this is a slow poll, not a live view.
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
          void refresh()
        }, 15000)
        return () => clearInterval(timer)
      }, [refresh])

      const saveEntry = useCallback(
        async (key, patch) => {
          setBusy(key)
          try {
            const current = (data?.entries ?? {})[key] ?? blankEntry()
            const result = await post('/models/preset', { key, entry: { ...current, ...patch, enabled: true } })
            setData((next) => next === undefined ? next : {
              ...next,
              entries: { ...next.entries, [key]: result.entry },
              models: next.models.map((row) => (row.key === key ? { ...row, entry: result.entry } : row)),
            })
            if (Array.isArray(result.problems) && result.problems.length > 0) {
              flashFor(`${t('models.saveFailed')}: ${result.problems.join(', ')}`)
            } else {
              flashFor(t('saved'))
            }
          } catch (problem) {
            flashFor(`${t('models.saveFailed')}: ${String(problem?.message ?? problem)}`)
          } finally {
            setBusy('')
          }
        },
        [data, t],
      )

      const removeEntry = useCallback(
        async (key) => {
          setBusy(key)
          try {
            await post('/models/preset', { key, remove: true })
            await refresh()
            flashFor(t('models.remove'))
          } catch (problem) {
            flashFor(String(problem?.message ?? problem))
          } finally {
            setBusy('')
          }
        },
        [refresh, t],
      )

      const saveScope = useCallback(
        async (value) => {
          setBusy('scope')
          try {
            const result = await post('/models/scope', { scope: String(value).split(/\r?\n/) })
            setScopeDraft((result.scope ?? []).join('\n'))
            await refresh()
            flashFor(t('saved'))
          } catch (problem) {
            flashFor(String(problem?.message ?? problem))
          } finally {
            setBusy('')
          }
        },
        [refresh, t],
      )

      const runProposal = useCallback(
        async (path, source) => {
          setBusy(source)
          try {
            const result = await post(path)
            setDraft({
              source,
              proposals: result.proposals ?? {},
              rejected: result.rejected ?? result.skipped ?? [],
              route: result.route,
              parsed: result.parsed,
              text: result.text,
            })
          } catch (problem) {
            flashFor(String(problem?.message ?? problem))
          } finally {
            setBusy('')
          }
        },
        [t],
      )

      const applyDraft = useCallback(
        async () => {
          if (draft === null) return
          const keys = Object.keys(draft.proposals ?? {})
          if (keys.length === 0) { setDraft(null); return }
          setBusy('draft')
          try {
            const result = await post('/models/bulk', { entries: draft.proposals })
            setDraft(null)
            await refresh()
            flashFor(`${t('models.applied')} · ${result.saved ?? keys.length}`)
          } catch (problem) {
            flashFor(String(problem?.message ?? problem))
          } finally {
            setBusy('')
          }
        },
        [draft, refresh, t],
      )

      const undo = useCallback(
        async () => {
          setBusy('undo')
          try {
            await post('/models/undo')
            await refresh()
            flashFor(t('models.undo'))
          } catch (problem) {
            flashFor(String(problem?.message ?? problem))
          } finally {
            setBusy('')
          }
        },
        [refresh, t],
      )

      if (error !== '' && data === undefined) {
        return h(
          'div',
          { className: 'ofa_root' },
          h('div', { className: 'ofa_title' }, t('title.models')),
          h('div', { className: 'ofa_err' }, `${t('backend')} · ${error}`),
          h('div', null, h('button', { type: 'button', className: 'ofa_btn', onClick: () => void refresh() }, t('retry'))),
        )
      }
      if (data === undefined) return h('div', { className: 'ofa_root' }, h('div', { className: 'ofa_note' }, t('loading')))

      const models = Array.isArray(data.models) ? data.models : []
      const entries = data.entries ?? {}
      const configured = models.filter((row) => entries[row.key] !== undefined).length
      const groups = groupByProvider(visibleModels(models, query, onlySet))
      const applied = data.applied ?? {}
      const keys = draft === null ? [] : Object.keys(draft.proposals ?? {})

      const strip = draft === null ? null : h(
        'div',
        { className: 'ofa_draft' },
        h(
          'div',
          { className: 'ofa_drafthead' },
          h('b', null, t('models.proposal', { n: keys.length })),
          h('button', { type: 'button', className: 'ofa_btn', disabled: busy !== '', onClick: () => void applyDraft() }, t('models.proposal.apply', { n: keys.length })),
          h('button', { type: 'button', className: 'ofa_btn', onClick: () => setDraft(null) }, t('models.proposal.cancel')),
          draft.route === undefined || draft.route.model === undefined
            ? null
            : h('span', { className: 'ofa_note' }, t('models.ai.route', { route: `${draft.route.provider}/${draft.route.model}` })),
        ),
        draft.parsed === false ? h('div', { className: 'ofa_warn' }, t('models.ai.bad')) : null,
        draft.rejected.length === 0
          ? null
          : h('div', { className: 'ofa_warn' }, t('models.proposal.rejected', {
              n: draft.rejected.length,
              why: draft.rejected.slice(0, 4).map((row) => `${row.key}:${row.reason}`).join(', '),
            })),
        keys.slice(0, 40).map((key) => h(
          'div',
          { key, className: 'ofa_draftrow' },
          h('span', { className: 'ofa_draftkey ofa_mono' }, key),
          h('span', { className: 'ofa_draftval' }, entrySummary(draft.proposals[key], t)),
        )),
        typeof draft.text === 'string' && draft.text !== ''
          ? h('details', null, h('summary', { className: 'ofa_note' }, t('models.ai.raw')), h('div', { className: 'ofa_pre' }, draft.text.slice(0, 4000)))
          : null,
      )

      return h(
        Fragment,
        null,
        h(
          'div',
          { className: 'ofa_root' },
          h(
            'div',
            { className: 'ofa_head' },
            h(
              'div',
              { className: 'ofa_headtext' },
              h('div', { className: 'ofa_title' }, t('title.models')),
              h(
                'div',
                { className: 'ofa_sub' },
                `${t('subtitle.models')} · v${data.version} · ${t('models.count', { total: models.length, set: configured })}`,
              ),
            ),
          ),
          h(
            Card,
            { title: t('models.scope') },
            h(
              Row,
              { name: t('models.scope'), hint: t('models.scope.hint') },
              h(CommittedInput, {
                value: scopeDraft,
                multiline: true,
                placeholder: 'our-free-model*',
                onCommit: (value) => void saveScope(value),
              }),
            ),
          ),
          h(
            Card,
            { title: t('models.list') },
            h(
              'div',
              { className: 'ofa_toolbar' },
              h('input', {
                className: 'ofa_input ofa_search',
                value: query,
                spellCheck: false,
                placeholder: t('models.search'),
                onChange: (event) => setQuery(event.target.value),
              }),
              h(Switch, { checked: onlySet, label: t('models.onlySet'), onChange: setOnlySet }),
              h('button', { type: 'button', className: 'ofa_btn', disabled: busy !== '', onClick: () => void runProposal('/models/top', 'top') }, t('models.top')),
              h('button', { type: 'button', className: 'ofa_btn', disabled: busy !== '', onClick: () => void runProposal('/models/ai', 'ai') }, t('models.ai')),
              h('button', { type: 'button', className: 'ofa_btn', disabled: busy !== '', onClick: () => void undo() }, t('models.undo')),
              h('button', { type: 'button', className: 'ofa_btn', disabled: busy !== '', onClick: () => void refresh() }, t('models.refresh')),
            ),
            h('div', { className: 'ofa_note' }, `${t('models.top.hint')} ${t('models.ai.hint')}`),
            flash === '' ? null : h('div', { className: 'ofa_note' }, flash),
            strip,
            groups.length === 0
              ? h('div', { className: 'ofa_note' }, t('models.empty'))
              : groups.map((group) => h(
                  'div',
                  { key: group.provider, className: 'ofa_mgroup' },
                  h('div', { className: 'ofa_mgroupname' }, group.provider),
                  group.rows.map((row) => h(ModelRow, {
                    key: row.key,
                    row,
                    t,
                    entry: entries[row.key] ?? null,
                    open: open === row.key,
                    busy: busy === row.key,
                    onToggle: () => setOpen(open === row.key ? '' : row.key),
                    onSave: (patch) => void saveEntry(row.key, patch),
                    onReset: () => void saveEntry(row.key, blankEntry()),
                    onRemove: () => void removeEntry(row.key),
                  })),
                )),
          ),
          h(
            'div',
            { className: 'ofa_foot' },
            h('b', null, t('models.appliedCount', { n: applied.count ?? 0 })),
            ' ',
            t('models.foot'),
          ),
        ),
      )
    }

    function apply(ctx) {
      installStyles()
      installTranscriptStyles()
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : ctx.locale
      const t = typeof locale?.bind === 'function' ? locale.bind(NS) : localT
      if (typeof locale?.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'ofm-addition: dictionaries')
      }
      // The count badge and the session's fold pass. `inject` hands the entry
      // its session, which is what the badge needs to find its own run.
      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'ofm-addition-count',
            order: 50,
            ...(typeof locale?.bind === 'function' ? { locale: NS } : {}),
            inject: (sessionId) => ({ sessionId }),
          },
          (props) => h(ContinueCountAction, { ...props, t }),
        ),
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'ofm-addition',
            // Sits immediately below Our Free Model (order 35) in the nav list.
            order: 36,
            label: () => t('nav'),
            ...(typeof locale?.bind === 'function' ? { locale: NS } : {}),
          },
          (props) => h(SettingsSection, { ...props, t }),
        ),
      )
      // The parameter page gets its own section rather than a card on the page
      // above: a table of every model needs room, and the continuation rules
      // stay readable while it grows.
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'ofm-addition-models',
            order: 37,
            label: () => t('nav.models'),
            ...(typeof locale?.bind === 'function' ? { locale: NS } : {}),
          },
          (props) => h(ModelsSection, { ...props, t }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'ofm-addition'
    // Test seam: the dictionaries and the pure render body are exercisable with
    // a stub React, so the offline rig can check the whole page without a shell.
    exports.DICT = DICT
    exports.SettingsSection = SettingsSection
    // Model-parameter seams: the summary line and the grouping are pure.
    exports.ModelsSection = ModelsSection
    exports.ModelRow = ModelRow
    exports.entrySummary = entrySummary
    exports.kilos = kilos
    exports.visibleModels = visibleModels
    exports.groupByProvider = groupByProvider
    exports.localT = localT
    // Transcript seams: the fold is DOM logic, exercised against a real DOM.
    exports.ContinueCountAction = ContinueCountAction
    exports.applyFold = applyFold
    exports.clearFold = clearFold
    exports.rowIsFolded = rowIsFolded
    exports.transcriptRoot = transcriptRoot
    exports.FOLD_ATTR = FOLD_ATTR
    exports.refreshAllReports = refreshAllReports
    return module.exports
  },
})
