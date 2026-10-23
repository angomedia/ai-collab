/* All model output is rendered as DOM text. The desktop bridge owns files and processes. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const bridge = window.council;
  const isMac = bridge?.platform === 'darwin';
  const setupTerminal = bridge?.platform === 'win32' ? 'PowerShell' : 'Terminal';
  document.documentElement.dataset.platform = bridge?.platform || '';
  document.querySelector('#new-chat kbd').textContent = isMac ? '⌘ N' : 'Ctrl N';
  $('start-debate').title = `Send question (${isMac ? '⌘' : 'Ctrl'} Enter)`;
  $('connections-description').textContent = `Use your own eligible Codex and Claude accounts. Setup opens ${setupTerminal} and your browser; sign in there, and the app detects the connection automatically.`;
  const state = { runs: [], providers: {}, models: {}, selectedRunId: null, activeRunId: null, drafts: new Map(), modelsLoading: false, modelError: '', starting: false, refreshing: false, attachmentsBusy: '', previewCache: new Map(), setupBusy: {}, setupNotes: {}, setupErrors: {}, preferences: null, preferencesLoaded: false, savingDefaults: false, defaultsMessage: '', defaultsError: '' };
  const messageNodes = new Map();
  const turnNodes = new Map();
  const connectionNodes = new Map();
  const clarificationDrafts = new Map();
  const reviewGroups = new Map();
  let autoScroll = true;
  let scrollScheduled = false;
  let toastTimer;
  let previewRequest = 0;
  let unsubscribeRun;
  let unsubscribeProviders;
  let renderedSourcesSignature = '';
  let renderedHistorySignature = '';
  let connectionsReturnFocus = null;
  let queuedModelRefresh = false;
  let clarificationScrollKey = null;
  const DEFAULT_MODERATOR_MODEL = 'gpt-6-sol';
  const names = { codex: 'Codex (ChatGPT)', claude: 'Claude', moderator: 'Moderator', system: 'System' };
  const shortNames = { codex: 'Codex', claude: 'Claude' };
  const providerHelp = { codex: { auth: 'https://learn.chatgpt.com/docs/auth', install: 'https://learn.chatgpt.com/docs/codex/cli' }, claude: { auth: 'https://code.claude.com/docs/en/authentication', install: 'https://code.claude.com/docs/en/setup' } };
  const kindNames = { clarification: 'A little context', plan: 'Perspectives', planning: 'Perspectives', analysis: 'Opening view', critique: 'Response', candidate: 'Shared draft', review: 'Draft review', adjudication: 'Decision', research: 'Web research' };
  const phaseNames = { starting: 'Getting started', clarification: 'Checking what else would help', awaiting_input: 'Your perspective is needed', knowledge: 'Checking whether anything needs looking up', research: 'Searching the web for missing context', planning: 'Assigning two starting perspectives', analysis: 'Exploring both perspectives', critique: 'Challenging and refining the ideas', synthesis: 'Bringing the ideas into a draft', candidate: 'Bringing the ideas into a draft', review: 'Reviewing the same draft', revision: 'Working through the objections', adjudication: 'Weighing the reviews', stopping: 'Stopping' };

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = String(value);
    return element;
  }
  function errorText(error) { return error?.message || String(error || 'Something went wrong. Please try again.'); }
  function selectedRun() { return state.runs.find((run) => run.id === state.selectedRunId); }
  function activeRun() { return state.runs.find((run) => run.id === state.activeRunId && run.status === 'running') || state.runs.find((run) => run.status === 'running'); }
  function isSetupPending(info) { return info?.setup?.pending ?? (!!info?.setup?.action && !info.setup.error); }
  function providerSetupPending() { return ['codex', 'claude'].some((provider) => state.setupBusy[provider] || isSetupPending(state.providers[provider])); }
  function dateValue(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? new Date() : date; }
  function statusLabel(status) { return ({ running: 'In progress', awaiting_input: 'Your input needed', completed: 'Complete', cancelled: 'Stopped', interrupted: 'Interrupted', failed: 'Needs attention', timed_out: 'Time limit reached' })[status] || status || ''; }
  function pendingClarification(run = selectedRun()) { return run?.status === 'awaiting_input' && run.clarification?.status === 'pending' ? run.clarification : null; }
  function shortDate(value) { const date = dateValue(value); return date.toDateString() === new Date().toDateString() ? 'Today' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function toast(value) { clearTimeout(toastTimer); $('toast').textContent = value; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
  function preferenceValues(value) {
    return { models: { codex: typeof value?.models?.codex === 'string' ? value.models.codex : '', claude: typeof value?.models?.claude === 'string' ? value.models.claude : '', moderator: value?.models?.moderator || DEFAULT_MODERATOR_MODEL }, timeoutMinutes: Number(value?.timeoutMinutes) || 20 };
  }
  function receivePreferences(value, initial = false) {
    state.preferences = preferenceValues(value);
    state.preferencesLoaded = true;
    const draft = state.drafts.get('__new__');
    if (draft && !draft.settingsTouched && (initial || (!draft.text.trim() && !draft.files.length && !state.attachmentsBusy))) {
      draft.models = { ...state.preferences.models };
      draft.timeoutMinutes = state.preferences.timeoutMinutes;
    }
  }
  function currentDraft(id = state.selectedRunId) {
    const key = id || '__new__';
    if (!state.drafts.has(key)) {
      const run = state.runs.find((item) => item.id === id);
      const settings = preferenceValues(run || (id ? null : state.preferences));
      state.drafts.set(key, { text: '', files: [], errors: [], error: '', models: settings.models, timeoutMinutes: settings.timeoutMinutes, settingsTouched: false });
    }
    return state.drafts.get(key);
  }
  function getTurns(run) {
    if (!run) return [];
    if (Array.isArray(run.turns) && run.turns.length) {
      return run.turns.map((turn, index) => index === run.turns.length - 1 ? { ...turn, status: run.status, final: run.final ?? turn.final, clarification: run.clarification ?? turn.clarification, error: run.error || turn.error, updatedAt: run.updatedAt } : turn);
    }
    return [{ id: run.turnId || run.id, question: run.currentQuestion || run.goal, createdAt: run.createdAt, updatedAt: run.updatedAt, status: run.status, final: run.final, error: run.error, models: run.models, plan: run.plan, clarification: run.clarification }];
  }
  function elapsed(run) {
    const turn = getTurns(run).at(-1);
    const end = run.status === 'running' ? Date.now() : dateValue(turn?.updatedAt || run.updatedAt).valueOf();
    const budget = Number(turn?.timeoutMinutes || run.timeoutMinutes) * 60000;
    const remaining = run.status === 'running' && Number.isFinite(run.deadline) ? Math.max(0, run.deadline - Date.now()) : run.remainingTimeMs;
    const duration = Number.isFinite(budget) && Number.isFinite(remaining) ? budget - remaining : end - dateValue(turn?.createdAt || run.createdAt).valueOf();
    const seconds = Math.max(0, Math.floor(duration / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  }
  function safeUrl(value) {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
  }

  // A deliberately small markdown reader: inline emphasis, code, links, lists, tables and fenced code.
  function inline(parent, value) {
    const source = String(value ?? '');
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
    let previous = 0;
    for (const match of source.matchAll(pattern)) {
      if (match.index > previous) parent.append(document.createTextNode(source.slice(previous, match.index)));
      const token = match[0];
      if (token[0] === '`') parent.append(node('code', '', token.slice(1, -1)));
      else if (token.startsWith('**') || token.startsWith('__')) parent.append(node('strong', '', token.slice(2, -2)));
      else if (token.startsWith('*')) parent.append(node('em', '', token.slice(1, -1)));
      else {
        const split = token.indexOf('](');
        const href = safeUrl(token.slice(split + 2, -1));
        if (href) {
          const link = node('a', '', token.slice(1, split));
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.addEventListener('click', async (event) => {
            event.preventDefault();
            try { await bridge.openLink(href); } catch (error) { toast(errorText(error)); }
          });
          parent.append(link);
        } else parent.append(document.createTextNode(token));
      }
      previous = match.index + token.length;
    }
    if (previous < source.length) parent.append(document.createTextNode(source.slice(previous)));
  }

  function markdown(value) {
    const fragment = document.createDocumentFragment();
    const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
    let index = 0;
    const tableCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    const isTableDivider = (line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line || '');
    const isSpecial = (line) => /^\s*$/.test(line) || /^\s*```/.test(line) || /^#{1,4}\s/.test(line) || /^\s*[-*+]\s/.test(line) || /^\s*\d+[.)]\s/.test(line) || /^>\s?/.test(line) || /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line);
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }
      if (/^\s*```/.test(line)) {
        const pre = node('pre');
        const code = node('code');
        const codeLines = [];
        index++;
        while (index < lines.length && !/^\s*```/.test(lines[index])) codeLines.push(lines[index++]);
        if (index < lines.length) index++;
        code.textContent = codeLines.join('\n');
        pre.append(code);
        fragment.append(pre);
        continue;
      }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) { const h = node(`h${heading[1].length}`); inline(h, heading[2].replace(/\s+#+$/, '')); fragment.append(h); index++; continue; }
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { fragment.append(node('hr')); index++; continue; }
      if (line.includes('|') && isTableDivider(lines[index + 1])) {
        const wrap = node('div', 'table-wrap');
        const table = node('table');
        const thead = node('thead');
        const header = node('tr');
        for (const text of tableCells(line)) { const cell = node('th'); inline(cell, text); header.append(cell); }
        thead.append(header); table.append(thead); index += 2;
        const tbody = node('tbody');
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
          const row = node('tr');
          for (const text of tableCells(lines[index++])) { const cell = node('td'); inline(cell, text); row.append(cell); }
          tbody.append(row);
        }
        table.append(tbody); wrap.append(table); fragment.append(wrap); continue;
      }
      if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) {
        const ordered = /^\s*\d+[.)]\s/.test(line);
        const list = node(ordered ? 'ol' : 'ul');
        if (ordered) list.start = Number(line.trim().match(/^\d+/)[0]);
        const matcher = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        while (index < lines.length && matcher.test(lines[index])) {
          const li = node('li');
          const parts = [matcher.exec(lines[index++])[1]];
          while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !isSpecial(lines[index])) parts.push(lines[index++].trim());
          inline(li, parts.join('\n')); list.append(li);
        }
        fragment.append(list); continue;
      }
      if (/^>\s?/.test(line)) {
        const quote = node('blockquote');
        const parts = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) parts.push(lines[index++].replace(/^>\s?/, ''));
        inline(quote, parts.join('\n')); fragment.append(quote); continue;
      }
      const paragraph = node('p');
      const parts = [lines[index++]];
      while (index < lines.length && !isSpecial(lines[index]) && !(lines[index].includes('|') && isTableDivider(lines[index + 1]))) parts.push(lines[index++]);
      inline(paragraph, parts.join('\n')); fragment.append(paragraph);
    }
    return fragment;
  }

  function naturalReview(message) {
    let review = message.review;
    if (!review) {
      try { review = JSON.parse(String(message.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { /* A review may contain a natural-language explanation. */ }
    }
    if (review && ['approve', 'revise'].includes(review.verdict)) {
      const issues = Array.isArray(review.issues) ? review.issues.filter((item) => typeof item === 'string' && item.trim()) : [];
      const suggestions = Array.isArray(review.suggestions) ? review.suggestions.filter((item) => typeof item === 'string' && item.trim()) : [];
      const approved = review.verdict === 'approve' && !issues.length;
      const version = review.candidate_version || review.candidateVersion || review.version;
      const output = [`**${approved ? 'I agree with this draft' : 'I still have concerns'}${Number.isInteger(version) ? ` (version ${version})` : ''}.**`];
      if (typeof review.summary === 'string' && review.summary.trim()) output.push(review.summary);
      if (issues.length) output.push(issues.map((issue) => `- ${issue}`).join('\n'));
      if (suggestions.length) output.push(`**Suggested changes**\n\n${suggestions.map((item) => `- ${item}`).join('\n')}`);
      if (!approved && !issues.length && !suggestions.length) output.push('The assistant requested further changes before approval.');
      return output.join('\n\n');
    }
    if (typeof message.summary === 'string' && message.summary.trim()) return message.summary;
    const text = String(message.text || '').trim();
    if (/^[{[]/.test(text) || /```(?:json)?\s*[{[]/i.test(text) || /"(?:verdict|candidate_version|issues)"\s*:/.test(text)) return 'This review could not be read reliably. It does not count as approval.';
    return text || 'No usable review was returned.';
  }

  function structuredMessage(message, key) {
    if (message[key] && typeof message[key] === 'object' && !Array.isArray(message[key])) return message[key];
    try { return JSON.parse(String(message.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { return null; }
  }
  function stringList(value) { return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []; }
  function messageFailure(message, fallback) {
    const error = typeof message.error === 'string' ? message.error.trim() : message.error?.message;
    // Protocol payloads are never a useful error display, including in older saved chats.
    if (!error || /^[{[]/.test(error) || /```(?:json)?\s*[{[]|"(?:refinedQuestion|roles|candidate_version|revisionInstructions)"\s*:/i.test(error)) return fallback;
    return error;
  }
  function messageStatusLabel(message) {
    if (message.status === 'running') return 'working';
    if (message.status !== 'failed') return '';
    return ({ cancelled: 'stopped', timed_out: 'time limit reached', interrupted: 'interrupted' })[message.failureKind] || 'failed';
  }
  function naturalAdjudication(message) {
    const decision = structuredMessage(message, 'adjudication') || message.decision;
    if (!decision || !['finalize', 'revise'].includes(decision.action)) return messageFailure(message, 'The moderator could not complete a reliable decision. This draft has not been finalized.');
    const version = Number.isInteger(decision.candidate_version) ? `Draft ${decision.candidate_version}` : 'This draft';
    const parts = [`**${version} ${decision.action === 'finalize' ? 'is ready as the final answer' : 'needs another revision'}.**`];
    if (typeof decision.reason === 'string' && decision.reason.trim()) parts.push(decision.reason);
    const changes = stringList(decision.revisionInstructions);
    const disagreements = stringList(decision.remainingDisagreements);
    if (changes.length) parts.push(`**Requested changes**\n\n${changes.map((text) => `- ${text}`).join('\n')}`);
    if (disagreements.length) parts.push(`**Remaining disagreements**\n\n${disagreements.map((text) => `- ${text}`).join('\n')}`);
    return parts.join('\n\n');
  }
  function planContent(message) {
    const plan = structuredMessage(message, 'plan');
    const body = node('div', 'moderator-plan');
    if (!plan?.refinedQuestion || !plan.roles?.codex?.label || !plan.roles?.claude?.label) {
      body.append(node('p', 'message-failure', messageFailure(message, 'The moderator could not validate a plan with two distinct perspectives.')));
      return { body, text: body.textContent };
    }
    body.append(node('span', 'section-eyebrow', 'The question we’re exploring'), node('p', 'plan-question', plan.refinedQuestion));
    const roles = node('div', 'plan-roles');
    const text = [plan.refinedQuestion];
    for (const provider of ['codex', 'claude']) {
      const role = plan.roles[provider];
      const line = node('div', `plan-role ${provider}`);
      const identity = node('div', 'role-identity');
      identity.append(node('span', `mini-avatar ${provider}`, 'C'), node('strong', '', shortNames[provider]));
      line.append(identity, node('span', 'role-caption', 'STARTING PERSPECTIVE'), node('p', 'role-label', role.label));
      roles.append(line); text.push(`${shortNames[provider]}: ${role.label}`);
    }
    body.append(roles);
    const details = node('details', 'plan-details');
    details.append(node('summary', '', 'Perspective details'));
    if (typeof plan.rationale === 'string' && plan.rationale.trim()) { details.append(node('p', '', plan.rationale)); text.push(plan.rationale); }
    for (const provider of ['codex', 'claude']) {
      const instructions = plan.roles[provider].instructions;
      if (typeof instructions !== 'string' || !instructions.trim()) continue;
      const paragraph = node('p');
      paragraph.append(node('strong', '', `${shortNames[provider]}: `), document.createTextNode(instructions));
      details.append(paragraph); text.push(`${shortNames[provider]}: ${instructions}`);
    }
    body.append(details);
    return { body, text: text.join('\n\n') };
  }

  function olderSnapshot(incoming, previous) {
    if (!previous) return false;
    const incomingTime = dateValue(incoming.updatedAt).valueOf();
    const previousTime = dateValue(previous.updatedAt).valueOf();
    if (incomingTime !== previousTime) return incomingTime < previousTime;
    const incomingTurns = incoming.turns?.length || 1;
    const previousTurns = previous.turns?.length || 1;
    if (incomingTurns !== previousTurns) return incomingTurns < previousTurns;
    if (!['running', 'awaiting_input'].includes(previous.status) && incoming.status === 'running') return true;
    if (!['running', 'awaiting_input'].includes(incoming.status) && previous.status === 'running') return false;
    return (incoming.messages || []).length < (previous.messages || []).length;
  }

  function renderProviders() {
    for (const provider of ['codex', 'claude']) {
      const info = state.providers[provider];
      let label = 'Checking'; let css = ''; let detail = 'Checking CLI login status.';
      if (info && !state.refreshing) {
        if (!info.available) { label = 'Not installed'; css = 'error'; detail = info.error || 'Open Connections to install the CLI.'; }
        else if (info.compatible === false) { label = 'Update CLI'; css = 'warning'; detail = info.error; }
        else if (info.authenticated === true) { label = 'Connected'; detail = `${info.version || ''} ${info.authType || 'Existing login'}`.trim(); }
        else { label = 'Connect'; css = 'warning'; detail = info.error || 'Open Connections to sign in with your own account.'; }
      }
      const control = node(info && (!info.available || info.compatible === false || info.authenticated !== true) ? 'button' : 'span', `connection-state ${css}`, label);
      if (control.tagName === 'BUTTON') {
        control.classList.add('sign-in'); control.title = `Connect ${shortNames[provider]}`;
        control.addEventListener('click', () => openConnections(provider));
      }
      $(`provider-${provider}`).replaceChildren(node('span', '', shortNames[provider]), control);
      $(`provider-${provider}`).title = detail;
      $(`provider-${provider}`).setAttribute('aria-label', `${shortNames[provider]}: ${label}. ${detail}`);
    }
    updateControls();
  }

  function openConnections(provider) {
    const dialog = $('connections-dialog');
    if (!dialog.open) { connectionsReturnFocus = document.activeElement; dialog.showModal(); }
    renderConnections();
    requestAnimationFrame(() => {
      const preferred = provider ? $(`connection-${provider}`).querySelector('.provider-primary:not(:disabled)') : dialog.querySelector('.needs-setup .provider-primary:not(:disabled)');
      (preferred || $('done-connections')).focus();
    });
  }
  function closeConnections() { if ($('connections-dialog').open) $('connections-dialog').close(); }

  function renderConnections() {
    const locked = !!activeRun() || state.starting;
    $('connections-active-notice').hidden = !locked;
    $('refresh-connections').disabled = state.refreshing;
    $('refresh-connections').textContent = state.refreshing ? 'Checking…' : 'Refresh status';
    for (const provider of ['codex', 'claude']) {
      let entry = connectionNodes.get(provider);
      if (!entry) {
        const container = $(`connection-${provider}`);
        const heading = node('div', 'connection-card-heading');
        const identity = node('div', 'connection-card-identity');
        const title = node('h3', 'connection-title', names[provider]);
        const status = node('span', 'connection-status'); status.setAttribute('role', 'status');
        identity.append(title, status);
        const primary = node('button', 'provider-primary');
        primary.addEventListener('click', () => setupConnection(provider, state.providers[provider]?.available && state.providers[provider]?.compatible !== false ? 'login' : 'install'));
        heading.append(identity, primary);
        const note = node('p', 'connection-setup-note'); note.setAttribute('role', 'status');
        const error = node('p', 'connection-setup-error'); error.setAttribute('role', 'alert');
        const details = node('details', 'connection-details');
        const version = node('p', 'connection-version');
        const path = node('p', 'connection-path');
        const diagnostic = node('p', 'connection-diagnostic');
        const actions = node('div', 'connection-location-actions');
        const choose = node('button', 'choose-executable', 'Choose executable…');
        choose.addEventListener('click', () => changeExecutable(provider, false));
        const reset = node('button', 'reset-executable', 'Use automatic detection');
        reset.addEventListener('click', () => changeExecutable(provider, true));
        actions.append(choose, reset);
        details.append(node('summary', '', 'Connection details'), version, path, diagnostic, actions);
        const help = node('button', 'provider-help', 'Official setup help ↗');
        help.addEventListener('click', async () => {
          try { await bridge.openLink(providerHelp[provider][state.providers[provider]?.available && state.providers[provider]?.compatible !== false ? 'auth' : 'install']); }
          catch (error) { state.setupErrors[provider] = errorText(error); renderConnections(); }
        });
        container.append(heading, note, error, details, help);
        entry = { container, status, primary, note, error, version, path, diagnostic, choose, reset }; connectionNodes.set(provider, entry);
      }
      const info = state.providers[provider];
      const connected = !!info?.available && info.compatible !== false && info.authenticated === true;
      const busy = !!state.setupBusy[provider];
      const pending = isSetupPending(info);
      const checking = !info || state.refreshing;
      entry.container.classList.toggle('connected', connected);
      entry.container.classList.toggle('needs-setup', !connected);
      entry.status.classList.toggle('connected', connected && !checking);
      const status = checking ? 'Checking…' : !info.available ? 'Not installed' : info.compatible === false ? 'Update required' : connected ? 'Connected' : 'Sign in needed';
      if (entry.status.textContent !== status) entry.status.textContent = status;
      entry.primary.textContent = busy ? 'Opening…' : pending ? info.setup.action === 'install' ? 'Installing…' : 'Connecting…' : !info?.available ? 'Install CLI' : info.compatible === false ? 'Update CLI' : connected ? 'Reconnect' : 'Connect';
      entry.primary.disabled = locked || busy || pending || checking;
      entry.choose.disabled = locked || busy || pending || state.refreshing;
      entry.reset.disabled = locked || busy || pending || state.refreshing;
      entry.reset.hidden = !info?.configuredPath;
      const note = info?.setup?.error ? '' : pending ? `Finish setup in ${setupTerminal} and your browser. This connection updates automatically.` : state.setupNotes[provider] || '';
      entry.note.hidden = !note; if (entry.note.textContent !== note) entry.note.textContent = note;
      const error = state.setupErrors[provider] || info?.setup?.error || (info?.compatible === false ? info.error : '') || '';
      entry.error.hidden = !error; if (entry.error.textContent !== error) entry.error.textContent = error;
      entry.version.hidden = !info?.version; entry.version.textContent = info?.version ? `Version: ${info.version}` : '';
      entry.path.hidden = !(info?.configuredPath || info?.path);
      entry.path.textContent = info?.configuredPath ? `Custom executable: ${info.configuredPath}` : info?.path ? `Executable: ${info.path}` : '';
      entry.diagnostic.hidden = !info?.error; entry.diagnostic.textContent = info?.error || '';
    }
  }

  async function setupConnection(provider, action) {
    if (activeRun() || state.starting || state.setupBusy[provider] || isSetupPending(state.providers[provider])) return;
    state.setupBusy[provider] = true; state.setupErrors[provider] = ''; state.setupNotes[provider] = ''; updateControls();
    try {
      const result = await bridge.setupProvider(provider, action);
      if (!result?.started) throw new Error('Setup did not start. Please try again.');
      state.setupNotes[provider] = `${setupTerminal} opened. Finish setup there and in your browser; the app checks the connection automatically.`;
    } catch (error) { state.setupErrors[provider] = errorText(error); }
    finally { state.setupBusy[provider] = false; updateControls(); }
  }

  async function changeExecutable(provider, reset) {
    if (activeRun() || state.starting || state.setupBusy[provider] || isSetupPending(state.providers[provider])) return;
    state.setupBusy[provider] = true; state.setupErrors[provider] = ''; state.setupNotes[provider] = ''; updateControls();
    try {
      const result = reset ? await bridge.clearProviderExecutable(provider) : await bridge.chooseProviderExecutable(provider);
      if (result?.providers) receiveProviders(result.providers);
      else if (!result?.cancelled) await refreshConnections(false);
    } catch (error) { state.setupErrors[provider] = errorText(error); }
    finally { state.setupBusy[provider] = false; updateControls(); }
  }

  function receiveProviders(providers) {
    const next = providers.providers || providers;
    const newlyConnected = ['codex', 'claude'].some((provider) => next[provider]?.authenticated === true && state.providers[provider]?.authenticated !== true);
    const setupCompleted = ['codex', 'claude'].some((provider) => state.providers[provider]?.setup && !next[provider]?.setup);
    const executableChanged = ['codex', 'claude'].some((provider) => state.providers[provider] && ((next[provider]?.path || '') !== (state.providers[provider]?.path || '') || (next[provider]?.configuredPath || '') !== (state.providers[provider]?.configuredPath || '')));
    state.providers = next;
    for (const provider of ['codex', 'claude']) if (next[provider]?.authenticated === true && !next[provider]?.setup) { state.setupNotes[provider] = ''; state.setupErrors[provider] = ''; }
    renderProviders();
    if (newlyConnected || setupCompleted || executableChanged) void refreshModels(true);
  }

  async function refreshConnections(refreshModelList = true) {
    if (state.refreshing) return;
    state.refreshing = true; $('refresh-providers').disabled = true; renderProviders();
    if (refreshModelList) void refreshModels(true);
    try { receiveProviders(await bridge.refreshProviders()); }
    catch (error) { toast(errorText(error)); }
    finally { state.refreshing = false; $('refresh-providers').disabled = false; renderProviders(); }
  }

  function renderHistory() {
    const runs = [...state.runs].sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt));
    const signature = JSON.stringify([state.selectedRunId, runs.map((run) => [run.id, run.goal, run.status, shortDate(run.updatedAt)])]);
    if (signature === renderedHistorySignature) return;
    renderedHistorySignature = signature;
    const list = $('chat-list'); list.replaceChildren();
    if (!state.runs.length) { list.append(node('p', 'history-empty', 'Your chats appear here.')); return; }
    for (const run of runs) {
      const button = node('button', `chat-item ${run.status}${run.id === state.selectedRunId ? ' selected' : ''}`);
      button.title = run.goal; button.setAttribute('aria-current', String(run.id === state.selectedRunId));
      button.append(node('span', 'chat-item-title', run.goal), node('span', 'chat-item-meta', `${shortDate(run.updatedAt)} · ${statusLabel(run.status)}`));
      button.addEventListener('click', () => selectRun(run.id)); list.append(button);
    }
  }

  function modelLabel(provider, id) {
    if (id === DEFAULT_MODERATOR_MODEL) return 'GPT-6 Sol';
    return id ? state.models[provider === 'moderator' ? 'codex' : provider]?.options?.find((item) => item.id === id)?.label || id : 'CLI default';
  }
  function moderatorAvailable() { return (state.models.codex?.options || []).some((item) => item.id && item.id === currentDraft().models.moderator); }
  function renderModels() {
    const draft = currentDraft();
    for (const provider of ['codex', 'claude', 'moderator']) {
      const select = $(`${provider}-model`);
      const moderator = provider === 'moderator';
      const options = [...(state.models[moderator ? 'codex' : provider]?.options || [])].filter((item) => !moderator || item.id);
      if (!moderator && !options.some((item) => item.id === '')) options.unshift({ id: '', label: 'CLI default' });
      const value = draft.models[provider] || (moderator ? DEFAULT_MODERATOR_MODEL : '');
      if (value && !options.some((item) => item.id === value)) options.push({ id: value, label: `${modelLabel(provider, value)} · ${moderator ? state.modelsLoading ? 'checking availability' : 'unavailable' : 'previously selected'}`, disabled: moderator });
      select.replaceChildren(...options.map((item) => { const option = node('option', '', item.label || item.id || 'CLI default'); option.value = item.id || ''; option.disabled = !!item.disabled; return option; }));
      select.value = value; select.disabled = state.starting || state.savingDefaults || !state.preferencesLoaded;
      select.title = options.find((item) => item.id === value)?.description || '';
    }
    if (![...$('timeout-minutes').options].some((option) => Number(option.value) === draft.timeoutMinutes)) {
      const option = node('option', '', `${draft.timeoutMinutes} minutes`); option.value = String(draft.timeoutMinutes); $('timeout-minutes').append(option);
    }
    $('timeout-minutes').value = String(draft.timeoutMinutes);
    $('timeout-minutes').disabled = state.starting || state.savingDefaults || !state.preferencesLoaded;
    $('refresh-models').disabled = state.modelsLoading;
    $('model-discovery-note').textContent = state.modelsLoading ? 'Loading model choices…' : state.modelError ? 'Discovery unavailable. Existing choices and CLI defaults still work.' : ['codex', 'claude'].map((provider) => `${shortNames[provider]}: ${state.models[provider]?.source === 'live' ? 'live list' : 'fallback choices'}`).join(' · ');
    $('model-discovery-note').title = [state.modelError, state.models.codex?.warning, state.models.claude?.warning].filter(Boolean).join('\n');
    renderDefaultsStatus();
    updateControls();
  }
  function renderDefaultsStatus() {
    $('save-defaults').disabled = state.savingDefaults || state.starting || !state.preferencesLoaded || !moderatorAvailable();
    $('save-defaults').textContent = state.savingDefaults ? 'Saving…' : 'Save as defaults';
    $('defaults-status').hidden = !state.defaultsMessage && !state.defaultsError;
    $('defaults-status').textContent = state.defaultsError || state.defaultsMessage;
    $('defaults-status').classList.toggle('error', !!state.defaultsError);
  }
  function settingsChanged() {
    currentDraft().settingsTouched = true;
    state.defaultsMessage = ''; state.defaultsError = '';
    renderDefaultsStatus(); updateControls();
  }
  async function saveDefaults() {
    if (state.savingDefaults || state.starting || !state.preferencesLoaded || !moderatorAvailable()) return;
    const draft = currentDraft();
    const selectedId = state.selectedRunId;
    const preferences = { models: { ...draft.models }, timeoutMinutes: draft.timeoutMinutes };
    state.savingDefaults = true; state.defaultsMessage = ''; state.defaultsError = ''; renderModels();
    try {
      const result = await bridge.savePreferences(preferences);
      receivePreferences(result.preferences || result);
      state.defaultsMessage = state.selectedRunId === selectedId ? 'Saved for new chats.' : '';
    } catch (error) { state.defaultsError = `Couldn’t save defaults: ${errorText(error)}`; }
    finally { state.savingDefaults = false; renderModels(); }
  }
  async function refreshModels(force = false) {
    if (state.modelsLoading) { if (force) queuedModelRefresh = true; return; }
    state.modelsLoading = true; state.modelError = ''; renderModels();
    try { const result = await bridge.getModels(force); state.models = result.models || result; }
    catch (error) { state.modelError = errorText(error); }
    finally { state.modelsLoading = false; renderModels(); if (queuedModelRefresh) { queuedModelRefresh = false; void refreshModels(true); } }
  }
  function toggleSettings(open = $('chat-settings').hidden) { if (open) closePreview(); $('chat-settings').hidden = !open; $('settings-toggle').setAttribute('aria-expanded', String(open)); }

  function sourcesFor(run = selectedRun(), draft = currentDraft()) {
    const sources = new Map((run?.attachments || []).map((file) => [file.id, { ...file, retained: true }]));
    for (const file of draft.files) if (!sources.has(file.id)) sources.set(file.id, { ...file, retained: false });
    return [...sources.values()];
  }
  function sourceChars(files = sourcesFor()) { return files.reduce((sum, file) => sum + (Number(file.charCount) || 0), 0); }
  function sourceLimit(files = sourcesFor()) { return files.length > 8 || sourceChars(files) > 200000; }
  function readableSize(value) { const bytes = Number(value) || 0; return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
  function fileDetails(file) { return `${String(file.extension || '').toUpperCase()} · ${readableSize(file.size)} · ${(Number(file.charCount) || 0).toLocaleString()} characters${file.retained ? ' · Already shared in this chat' : ' · Shared when you send'}`; }
  function closePreview() { previewRequest++; $('source-preview').hidden = true; }
  async function previewSource(file) {
    toggleSettings(false);
    const request = ++previewRequest;
    $('source-preview').hidden = false; $('source-preview-title').textContent = file.name;
    $('source-preview-text').textContent = file.preview || state.previewCache.get(file.id)?.preview || 'Loading preview…';
    $('source-preview-warning').hidden = !(file.warnings || []).length;
    $('source-preview-warning').textContent = (file.warnings || []).join(' ');
    if (file.preview || state.previewCache.get(file.id)?.preview) return;
    try {
      if (!state.selectedRunId) throw new Error('A preview is unavailable for this file.');
      const files = await bridge.reuseAttachments(state.selectedRunId);
      for (const item of files) state.previewCache.set(item.id, item);
      if (previewRequest !== request) return;
      const source = files.find((item) => item.id === file.id);
      $('source-preview-text').textContent = source?.preview || 'No text preview is available.';
      $('source-preview-warning').hidden = !(source?.warnings || []).length;
      $('source-preview-warning').textContent = (source?.warnings || []).join(' ');
    } catch (error) { if (previewRequest === request) $('source-preview-text').textContent = errorText(error); }
  }
  function renderSources() {
    const draft = currentDraft(); const files = sourcesFor();
    const signature = JSON.stringify([state.selectedRunId, files, draft.errors, state.starting, state.attachmentsBusy]);
    if (signature === renderedSourcesSignature) { updateControls(); return; }
    renderedSourcesSignature = signature;
    $('source-list').hidden = files.length === 0;
    $('source-list').replaceChildren(...files.map((file) => {
      const chip = node('span', `source-chip${file.retained ? ' retained' : ''}`);
      chip.dataset.attachmentId = file.id;
      const name = node('button', 'source-name', file.name); name.type = 'button'; name.title = fileDetails(file);
      name.addEventListener('click', () => previewSource(file)); chip.append(name);
      if (!file.retained) {
        const remove = node('button', 'source-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${file.name}`);
        remove.disabled = state.starting || !!state.attachmentsBusy;
        remove.addEventListener('click', () => removeSource(file.id)); chip.append(remove);
      }
      return chip;
    }));
    $('attachment-errors').hidden = !draft.errors.length;
    $('attachment-error-list').replaceChildren(...draft.errors.map((item) => node('li', '', `${item.name || 'File'} — ${errorText(item.error)}`)));
    updateControls();
  }
  async function pickSources() {
    if (state.starting || state.attachmentsBusy || sourcesFor().length >= 8) return;
    const draft = currentDraft(); const run = selectedRun();
    state.attachmentsBusy = 'Reading files…'; draft.errors = []; renderSources();
    try {
      const result = await bridge.pickAttachments();
      const retained = new Set((run?.attachments || []).map((file) => file.id));
      const files = new Map(draft.files.map((file) => [file.id, file]));
      for (const file of result.attachments || []) if (!retained.has(file.id)) files.set(file.id, file);
      draft.files = [...files.values()]; draft.errors = result.errors || [];
    } catch (error) { draft.errors = [{ name: 'File picker', error: errorText(error) }]; }
    finally { state.attachmentsBusy = ''; renderSources(); }
  }
  async function removeSource(id) {
    if (state.starting || state.attachmentsBusy) return;
    const draft = currentDraft(); state.attachmentsBusy = 'Updating files…'; renderSources();
    try { await bridge.removeAttachment(id); draft.files = draft.files.filter((file) => file.id !== id); closePreview(); }
    catch (error) { toast(errorText(error)); }
    finally { state.attachmentsBusy = ''; renderSources(); }
  }

  function updateControls() {
    const draft = currentDraft(); const run = selectedRun(); const active = activeRun(); const sources = sourcesFor(run, draft);
    const pending = pendingClarification(run);
    for (const entry of turnNodes.values()) {
      updateClarificationControls(entry);
      if (!entry.retry) continue;
      const draftText = draft.text.trim();
      entry.retry.disabled = state.starting || !!active || (!!draftText && draftText !== entry.user.textContent.trim());
      entry.retry.title = entry.retry.disabled && draftText ? 'Your unsent draft is kept below. Clear it to reuse this question.' : 'Restore this question in the composer. Files stay attached to this chat.';
    }
    const ready = ['codex', 'claude'].every((provider) => state.providers[provider]?.available && state.providers[provider]?.compatible !== false && state.providers[provider]?.authenticated === true);
    $('start-debate').disabled = !!pending || state.starting || !state.preferencesLoaded || !!state.attachmentsBusy || providerSetupPending() || !!active || !ready || !moderatorAvailable() || !draft.text.trim() || sourceLimit(sources);
    $('start-debate').setAttribute('aria-label', run ? 'Send follow-up' : 'Send question');
    $('attach-files').disabled = !!pending || state.starting || !!state.attachmentsBusy || sources.length >= 8;
    $('attach-files-label').textContent = state.attachmentsBusy || 'Attach';
    $('attach-files').title = sources.length >= 8 ? 'This chat already has 8 files.' : 'Attach PDF, Word, text, CSV, JSON, or Excel files';
    $('composer-context').textContent = sources.length ? `${sources.length} ${sources.length === 1 ? 'file' : 'files'}` : '';
    $('composer-context').title = `${sourceChars(sources).toLocaleString()} of 200,000 extracted characters · Up to 8 files per chat`;
    $('stop-active-run').hidden = !active && !pending; $('stop-active-run').disabled = active?.phase === 'stopping';
    $('view-active').hidden = !active || active.id === state.selectedRunId;
    $('send-error').hidden = !draft.error; $('send-error').textContent = draft.error;
    let notice = '';
    if (pending) notice = 'Answer the questions above, or choose Use best judgment, to continue.';
    else if (sourceLimit(sources)) notice = sources.length > 8 ? 'Choose up to 8 files per chat. Remove a new attachment to send.' : 'The files exceed 200,000 extracted characters. Remove a new attachment or start a new chat.';
    else if (providerSetupPending()) notice = ['codex', 'claude'].some((provider) => isSetupPending(state.providers[provider]) && state.providers[provider]?.setup?.error) ? `Finish or cancel setup in ${setupTerminal}, then refresh Connections before sending.` : `Finish connecting in ${setupTerminal} and your browser before sending.`;
    else if (['codex', 'claude'].some(provider => state.providers[provider]?.compatible === false)) notice = 'Open Connections to update the CLI before sending.';
    else if (!ready && Object.keys(state.providers).length) {
      const missing = ['codex', 'claude'].filter((provider) => !state.providers[provider]?.available);
      const unsigned = ['codex', 'claude'].filter((provider) => state.providers[provider]?.available && state.providers[provider]?.authenticated !== true);
      notice = missing.length ? `Open Connections to install ${missing.map((provider) => shortNames[provider]).join(' and ')}.` : `Open Connections to sign in to ${unsigned.map((provider) => shortNames[provider]).join(' and ')}.`;
    } else if (active && active.id !== state.selectedRunId) notice = 'Another chat is running. Open it or stop it before sending.';
    else if (!moderatorAvailable() && !state.modelsLoading) notice = 'Choose an available moderator model in Models & time.';
    $('composer-notice').hidden = !notice; $('composer-notice').textContent = notice;
    $('composer-notice').classList.toggle('error', sourceLimit(sources));
    renderConnections();
  }

  function draftVersion(message) {
    return message.candidateVersion || message.review?.candidateVersion || message.review?.candidate_version || message.adjudication?.candidate_version || null;
  }
  function responseSummary(message) {
    const summary = message.summary;
    return summary && typeof summary === 'object' && !Array.isArray(summary) && typeof summary.headline === 'string' && summary.headline.trim()
      ? { headline: summary.headline, points: stringList(summary.points).slice(0, 3) } : null;
  }
  function renderCompactResponse(message, entry) {
    // Keep the full-response node stable while deltas arrive: an open detail,
    // selection, and reader scroll position must survive each snapshot.
    if (!entry.compact) {
      const summary = node('div', 'message-summary');
      const eyebrow = node('span', 'summary-label');
      const headline = node('p', 'summary-headline');
      const points = node('ul', 'summary-points');
      const preview = node('p', 'response-excerpt');
      summary.append(eyebrow, headline, points, preview);
      const details = node('details', 'full-response');
      const toggle = node('summary', '', 'Full response');
      const full = node('div', 'markdown-content full-response-content');
      const attribution = node('p', 'summary-attribution', 'The short version above was summarized by GPT-6 Sol. This is the assistant’s original response.');
      details.append(toggle, attribution, full); entry.body.replaceChildren(summary, details);
      entry.compact = { summary, eyebrow, headline, points, preview, details, toggle, full, attribution };
    }
    const compact = entry.compact;
    const summary = responseSummary(message);
    const running = message.status === 'running';
    const text = String(message.text || '');
    compact.eyebrow.textContent = summary ? 'KEY POINTS' : running ? 'LIVE RESPONSE' : 'RESPONSE PREVIEW';
    compact.headline.hidden = !summary;
    compact.points.hidden = !summary?.points.length;
    compact.preview.hidden = !!summary;
    compact.attribution.hidden = !summary;
    if (summary) {
      if (compact.headline.textContent !== summary.headline) compact.headline.textContent = summary.headline;
      const pointsKey = JSON.stringify(summary.points);
      if (compact.points.dataset.signature !== pointsKey) { compact.points.dataset.signature = pointsKey; compact.points.replaceChildren(...summary.points.map(text => node('li', '', text))); }
    } else {
      // An excerpt is explicitly labelled; it is never presented as an AI summary.
      const excerpt = text.trim().replace(/\s+/g, ' ');
      const preview = excerpt ? `${excerpt.slice(0, 280)}${excerpt.length > 280 ? '…' : ''}` : message.status === 'failed' ? messageFailure(message, 'No response was returned.') : 'Thinking through this perspective…';
      if (compact.preview.textContent !== preview) compact.preview.textContent = preview;
    }
    compact.toggle.textContent = running ? 'Full response · live' : 'Full response';
    if (compact.full.dataset.text !== text) { compact.full.dataset.text = text; compact.full.replaceChildren(text ? markdown(text) : node('p', 'message-placeholder', 'The response will appear here as it arrives.')); }
  }
  function renderReview(message, entry) {
    const review = message.review || structuredMessage(message, 'review');
    const pending = message.status === 'running' || message.text === 'Validating the response…';
    const approved = !pending && review?.valid !== false && review?.verdict === 'approve' && !stringList(review.issues).length;
    const usable = !pending && review && ['approve', 'revise'].includes(review.verdict);
    const badge = node('span', `review-verdict ${approved ? 'approved' : 'concern'}`, pending ? 'Reviewing…' : approved ? '✓ Approves' : usable ? 'Changes requested' : 'Review unavailable');
    entry.element.dataset.verdict = approved ? 'approve' : pending ? 'pending' : 'revise';
    entry.body.replaceChildren(badge);
    if (pending) { entry.body.append(node('p', 'message-placeholder', 'Checking this exact draft.')); return; }
    if (!usable) { const safe = node('div', 'review-explanation'); safe.append(markdown(naturalReview(message))); entry.body.append(safe); return; }
    const explanation = typeof review.summary === 'string' && review.summary.trim() ? review.summary : approved ? 'No blocking concerns with this draft.' : 'These concerns need to be addressed.';
    entry.body.append(node('p', 'review-explanation', explanation));
    const issues = stringList(review.issues);
    if (issues.length) { const list = node('ul', 'review-issues'); for (const issue of issues.slice(0, 2)) list.append(node('li', '', issue)); entry.body.append(list); }
    const suggestions = stringList(review.suggestions);
    if (issues.length > 2 || suggestions.length) {
      const details = node('details', 'review-details'); details.append(node('summary', '', 'Review details'));
      const list = node('ul'); for (const text of [...issues.slice(2), ...suggestions]) list.append(node('li', '', text)); details.append(list); entry.body.append(details);
    }
  }
  function renderMessage(message, container, turn) {
    let entry = messageNodes.get(message.id);
    if (!entry) {
      if (message.provider === 'system' || message.kind === 'system') {
        const element = node('div', 'system-message'); entry = { element, body: element, system: true };
      } else {
        const provider = ['codex', 'claude', 'moderator'].includes(message.provider) ? message.provider : 'codex';
        const element = node('article', `assistant-message ${provider}`); element.dataset.provider = provider; element.dataset.kind = message.kind;
        const heading = node('div', 'message-heading');
        const dot = node('span', 'provider-dot', provider === 'moderator' ? '◇' : 'C'); dot.setAttribute('aria-hidden', 'true');
        const label = node('span', 'message-label');
        const copy = node('button', 'message-copy', 'Copy'); copy.title = `Copy ${names[provider]}’s response`;
        copy.addEventListener('click', () => copyText(entry.copyText || ''));
        const name = node('strong', 'message-name', names[provider]);
        const identity = node('div', 'message-identity'); identity.append(name, label);
        heading.append(dot, identity, copy);
        const perspective = node('p', 'message-perspective'); perspective.hidden = true;
        const body = node('div', 'message-body markdown-content'); element.append(heading, perspective, body);
        entry = { element, body, label, name, perspective, copy };
      }
      messageNodes.set(message.id, entry);
    }
    if (entry.element.parentNode !== container) container.append(entry.element);
    if (entry.system) { const text = message.text || message.title || ''; if (entry.body.textContent !== text) entry.body.textContent = text; return; }
    const status = messageStatusLabel(message);
    const version = draftVersion(message);
    const label = `${kindNames[message.kind] || 'Response'}${version && ['candidate', 'review'].includes(message.kind) ? ` ${version}` : ''}${status ? ` · ${status}` : ''}`;
    if (entry.label.textContent !== label) entry.label.textContent = label;
    entry.element.classList.toggle('is-streaming', message.status === 'running');
    entry.element.classList.toggle('is-failed', message.status === 'failed');
    const name = message.provider === 'moderator' ? `Moderator · ${modelLabel('moderator', message.model || turn.models?.moderator || DEFAULT_MODERATOR_MODEL)}` : names[message.provider] || names.codex;
    if (entry.name.textContent !== name) entry.name.textContent = name;
    // Research remains visible, including citations, and precedes role assignment.
    const researching = message.kind === 'research';
    const role = researching || message.kind === 'review' ? null : turn.plan?.roles?.[message.provider];
    const lookup = stringList(message.lookup).length ? stringList(message.lookup) : stringList(message.queries);
    const perspective = researching ? lookup.length ? `Looking up: ${lookup.join(', ')}` : '' : role?.label ? `Starting perspective: ${role.label}` : '';
    entry.perspective.hidden = !perspective;
    if (entry.perspective.textContent !== perspective) entry.perspective.textContent = perspective;
    entry.perspective.title = typeof role?.instructions === 'string' ? role.instructions : '';
    const signature = JSON.stringify([message.text, message.status, message.error, message.failureKind, message.review, message.summary, message.plan, message.adjudication, message.decision, message.clarification]);
    if (signature === entry.signature) return;
    entry.signature = signature;
    const planning = ['plan', 'planning'].includes(message.kind);
    const adjudicating = message.kind === 'adjudication';
    const clarifying = message.kind === 'clarification';
    const pendingStructured = (planning || adjudicating || clarifying || message.kind === 'review') && (message.status === 'running' || message.text === 'Validating the response…');
    entry.body.classList.toggle('moderator-adjudication', adjudicating);
    entry.copy.disabled = pendingStructured;
    if (pendingStructured && message.kind !== 'review') {
      entry.copyText = '';
      entry.body.replaceChildren(node('p', 'message-placeholder', planning ? 'Refining the question and assigning distinct perspectives…' : adjudicating ? 'Weighing the draft, reviews, and remaining disagreements…' : 'Checking whether a little more context would change the answer…'));
      return;
    }
    if (planning) { const plan = planContent(message); entry.copyText = plan.text; entry.body.replaceChildren(plan.body); return; }
    if (clarifying) {
      const text = message.clarification?.reason || messageFailure(message, 'The clarification check could not be completed.');
      entry.copyText = text; entry.body.replaceChildren(node('p', 'message-failure', text)); return;
    }
    const text = message.kind === 'review' ? naturalReview(message) : adjudicating ? naturalAdjudication(message) : message.text || '';
    entry.copyText = text;
    if (message.kind === 'review') { renderReview(message, entry); return; }
    if (['analysis', 'critique', 'candidate'].includes(message.kind)) { renderCompactResponse(message, entry); return; }
    entry.body.replaceChildren(text ? markdown(text) : node('p', 'message-placeholder', 'Thinking…'));
  }

  function renderFinal(turn, entry) {
    const final = turn.final;
    const visible = turn.status !== 'running' && final?.text;
    entry.final.hidden = !visible;
    if (!visible) return;
    const signature = JSON.stringify([final, turn.status]);
    if (signature === entry.finalSignature) return;
    entry.finalSignature = signature;
    const reviewed = final.reviewed !== false;
    const moderated = Object.hasOwn(final, 'decided') || !!final.moderation;
    const decided = moderated && turn.status === 'completed' && final.decided === true;
    const agreed = reviewed && final.consensus === true && (!moderated || decided);
    const ready = agreed || decided;
    const heading = node('div', 'final-heading');
    heading.append(node('h3', '', ready ? 'Final answer' : 'Latest draft'), node('span', `final-badge${agreed ? '' : ' unresolved'}`, agreed ? 'Both agree' : decided ? 'Moderator decision' : !reviewed ? 'Not fully reviewed' : moderated ? 'Not finalized' : 'Open questions'));
    const answer = node('div', 'markdown-content'); answer.append(markdown(final.text));
    entry.final.replaceChildren(node('div', 'section-eyebrow final-eyebrow', ready ? 'THE RESULT' : 'WHERE THE DISCUSSION REACHED'), heading);
    if (!ready) {
      const explanation = !reviewed ? 'The chat stopped before both assistants reviewed this draft. Treat it as unfinished.' : moderated ? `${turn.status === 'timed_out' ? 'The time limit was reached' : 'The chat stopped'} before the moderator finalized this draft. Treat it as unfinished.` : turn.status === 'timed_out' ? 'The time limit was reached. This draft keeps the remaining disagreements visible.' : 'This is the latest reviewed answer. The assistants still have unresolved objections.';
      entry.final.append(node('p', 'final-note', explanation));
    }
    entry.final.append(answer);
    const unresolved = stringList(final.unresolved);
    const reviews = Array.isArray(final.reviews) ? final.reviews : [];
    if (moderated && final.moderation) {
      if (typeof final.moderation.reason === 'string' && final.moderation.reason.trim()) {
        const reason = node('p', 'moderation-reason');
        reason.append(node('strong', '', 'Moderator’s reasoning: '), document.createTextNode(final.moderation.reason));
        entry.final.append(reason);
      }
      const disagreements = [...new Set([...stringList(final.moderation.remainingDisagreements), ...(!agreed ? unresolved : [])])];
      if (disagreements.length) {
        const section = node('div', 'moderation-disagreements');
        section.append(node('strong', '', 'Remaining disagreements'));
        const list = node('ul'); for (const text of disagreements) list.append(node('li', '', text));
        section.append(list); entry.final.append(section);
      }
    }
    if (unresolved.length || reviews.some((review) => review.verdict !== 'approve' || review.issues?.length || review.suggestions?.length)) {
      const details = node('details', 'final-review-details');
      details.append(node('summary', '', 'Review notes'));
      const list = node('ul');
      const notes = new Set(unresolved.map((item) => typeof item === 'string' ? item : JSON.stringify(item)));
      for (const review of reviews) {
        const label = shortNames[review.provider] || review.provider;
        for (const item of [...(review.issues || []), ...(review.suggestions || [])]) notes.add(`${label}: ${typeof item === 'string' ? item : JSON.stringify(item)}`);
      }
      for (const text of notes) list.append(node('li', '', text));
      details.append(list); entry.final.append(details);
    }
    const footer = node('div', 'final-footer');
    const copy = node('button', 'text-button', 'Copy answer'); copy.addEventListener('click', () => copyText(final.text));
    footer.append(copy, node('span', 'final-version', `Draft ${final.version || 1}`)); entry.final.append(footer);
  }

  function clarificationDraft(runId, clarification) {
    const key = `${runId}:${clarification.id}`;
    if (!clarificationDrafts.has(key)) clarificationDrafts.set(key, { answers: Object.fromEntries((clarification.answers || []).map(item => [item.id, item.answer])), busy: false, error: '' });
    return clarificationDrafts.get(key);
  }
  function updateClarificationControls(entry) {
    const ui = entry.clarificationUI;
    if (!ui) return;
    const { runId, clarification, local } = ui;
    const run = state.runs.find(item => item.id === runId);
    const pending = run?.status === 'awaiting_input' && run.clarification?.id === clarification.id && run.clarification?.status === 'pending';
    const active = activeRun();
    const ready = ['codex', 'claude'].every(provider => state.providers[provider]?.available && state.providers[provider]?.compatible !== false && state.providers[provider]?.authenticated === true);
    const locked = !pending || local.busy || state.starting || !!active || providerSetupPending() || !ready;
    for (const field of ui.fields) {
      field.input.disabled = locked;
      for (const button of field.options) {
        button.disabled = locked;
        button.setAttribute('aria-pressed', String(local.answers[field.id]?.trim() === button.textContent));
      }
    }
    ui.submit.disabled = locked || clarification.questions.some(question => !local.answers[question.id]?.trim());
    ui.submit.textContent = local.busy ? 'Continuing…' : 'Continue debate';
    ui.assumptions.disabled = locked;
    const status = active && active.id !== runId ? 'Another chat is running. Finish or stop it before continuing this debate.' : providerSetupPending() ? `Finish connecting in ${setupTerminal} before continuing.` : !ready ? 'Connect both assistants to continue. Your answers will stay here.' : 'Take your time. The debate’s time limit is paused while you answer.';
    ui.status.textContent = status;
    ui.error.hidden = !local.error; ui.error.textContent = local.error;
  }
  async function answerClarification(runId, clarification, useAssumptions) {
    const local = clarificationDraft(runId, clarification);
    const run = state.runs.find(item => item.id === runId);
    const ready = ['codex', 'claude'].every(provider => state.providers[provider]?.available && state.providers[provider]?.compatible !== false && state.providers[provider]?.authenticated === true);
    if (local.busy || state.starting || activeRun() || providerSetupPending() || !ready || !pendingClarification(run) || run.clarification.id !== clarification.id) return;
    const answers = clarification.questions.map(question => ({ id: question.id, answer: (local.answers[question.id] || '').trim() })).filter(answer => answer.answer);
    if (!useAssumptions && answers.length !== clarification.questions.length) return;
    local.busy = true; local.error = ''; updateControls();
    try {
      const updated = await bridge.answerClarification(runId, { clarificationId: clarification.id, answers, useAssumptions });
      if (state.selectedRunId === runId) autoScroll = true;
      onRunUpdate(updated);
      if (state.selectedRunId === runId) $('goal').focus();
    } catch (error) { local.error = errorText(error); }
    finally { local.busy = false; updateControls(); }
  }
  function renderClarification(run, turn, entry) {
    const clarification = turn.clarification;
    const visible = clarification?.needsClarification && Array.isArray(clarification.questions) && clarification.questions.length;
    entry.clarification.hidden = !visible;
    if (!visible) return;
    const pending = clarification.status === 'pending' && turn.status === 'awaiting_input';
    const signature = JSON.stringify([clarification.id, clarification.status, clarification.reason, clarification.questions, clarification.answers, pending]);
    if (entry.clarificationSignature === signature) { updateClarificationControls(entry); return; }
    entry.clarificationSignature = signature;
    entry.clarificationUI = null;
    const panel = entry.clarification;
    panel.dataset.clarificationId = clarification.id;
    panel.classList.toggle('answered', !pending);
    panel.replaceChildren();
    const header = node('div', 'clarification-heading');
    header.append(node('span', 'moderator-mark', '◇'), node('span', 'section-eyebrow', pending ? 'BEFORE WE BEGIN' : 'YOUR CONTEXT'));
    panel.append(header);
    if (!pending) {
      const assumptions = clarification.status === 'assumptions';
      panel.append(node('h3', '', assumptions ? 'Continuing with your context and best judgment' : clarification.status === 'cancelled' ? 'Clarification was cancelled' : 'Your answers are part of the debate'));
      const details = node('details', 'clarification-recap'); details.append(node('summary', '', assumptions ? 'Answers and assumptions' : 'View your answers'));
      const answers = new Map((clarification.answers || []).map(answer => [answer.id, answer.answer]));
      for (const question of clarification.questions) {
        const item = node('div', 'clarification-recap-item');
        item.append(node('strong', '', question.question), node('p', '', answers.get(question.id) || (assumptions ? 'Use a clearly stated assumption.' : 'No answer supplied.'))); details.append(item);
      }
      panel.append(details); return;
    }
    panel.append(node('h3', '', 'A little context will make this more useful.'), node('p', 'clarification-reason', clarification.reason));
    const form = node('form', 'clarification-form');
    const local = clarificationDraft(run.id, clarification);
    const fields = [];
    for (const [index, question] of clarification.questions.slice(0, 3).entries()) {
      const field = node('div', 'clarification-question'); field.dataset.questionId = question.id;
      const inputId = `clarification-${clarification.id}-${index}`;
      const label = node('label', 'clarification-label'); label.htmlFor = inputId;
      label.append(node('span', 'question-number', String(index + 1)), document.createTextNode(question.question));
      const options = node('div', 'clarification-options');
      const buttons = [];
      const input = node('textarea', 'clarification-answer'); input.id = inputId; input.rows = 2; input.maxLength = 4000; input.placeholder = question.options?.length ? 'Choose an option above, or answer in your own words…' : 'Your answer…'; input.value = local.answers[question.id] || '';
      for (const choice of stringList(question.options).slice(0, 5)) {
        const button = node('button', 'clarification-option', choice); button.type = 'button'; button.setAttribute('aria-pressed', String(input.value.trim() === choice));
        button.addEventListener('click', () => { local.answers[question.id] = choice; local.error = ''; input.value = choice; updateClarificationControls(entry); });
        buttons.push(button); options.append(button);
      }
      input.addEventListener('input', () => { local.answers[question.id] = input.value; local.error = ''; updateClarificationControls(entry); });
      field.append(label); if (buttons.length) field.append(options); field.append(input); form.append(field); fields.push({ id: question.id, input, options: buttons });
    }
    const actions = node('div', 'clarification-actions');
    const submit = node('button', 'clarification-continue', 'Continue debate'); submit.type = 'submit';
    const assumptions = node('button', 'clarification-assumptions', 'Use best judgment'); assumptions.type = 'button'; assumptions.title = 'Continue with any answers you supplied and clearly stated assumptions for the rest.';
    assumptions.addEventListener('click', () => answerClarification(run.id, clarification, true));
    actions.append(submit, assumptions); form.append(actions);
    const hint = node('p', 'clarification-assumptions-note', 'Use best judgment lets the assistants make explicit assumptions for anything you leave open.');
    const status = node('p', 'clarification-status'); status.setAttribute('role', 'status');
    const error = node('p', 'clarification-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    form.addEventListener('submit', event => { event.preventDefault(); answerClarification(run.id, clarification, false); });
    panel.append(form, hint, status, error);
    entry.clarificationUI = { runId: run.id, clarification, local, fields, submit, assumptions, status, error };
    updateClarificationControls(entry);
  }
  function renderProgress(run) {
    $('debate-progress').hidden = !run;
    if (!run) return;
    const phase = run.phase;
    const stage = run.status === 'completed' ? 3 : ['review', 'revision', 'adjudication'].includes(phase) ? 2 : ['knowledge', 'research', 'planning', 'analysis', 'critique', 'synthesis', 'candidate'].includes(phase) ? 1 : phase === 'awaiting_input' || phase === 'clarification' || phase === 'starting' ? 0 : run.final ? 2 : (run.messages || []).some(message => message.kind === 'analysis') ? 1 : 0;
    [...$('debate-progress').querySelectorAll('.progress-step')].forEach((step, index) => {
      step.classList.toggle('is-current', index === stage); step.classList.toggle('is-complete', index < stage || run.status === 'completed');
      if (index === stage) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
      step.querySelector('.step-number').textContent = index < stage || run.status === 'completed' ? '✓' : String(index + 1);
    });
    const detail = run.status === 'awaiting_input' ? 'Waiting for you · timer paused' : run.status === 'running' ? `${phaseNames[phase] || 'Working through the question'}${run.round > 0 && stage === 2 ? ` · Draft ${run.round}` : ''}` : statusLabel(run.status);
    if ($('progress-detail').textContent !== detail) $('progress-detail').textContent = detail;
  }
  function reviewContainer(message, entry, turn, sequence, superseded = false) {
    const version = draftVersion(message) || sequence || 1;
    const key = `${turn.id}:review:${version}`;
    let group = reviewGroups.get(key);
    if (!group) {
      const element = node('section', 'review-comparison'); element.dataset.version = version;
      const heading = node('div', 'review-comparison-heading'); heading.append(node('span', 'section-eyebrow', `DRAFT ${version}`), node('h3', '', 'Do both perspectives hold up?'), node('p', '', 'Both assistants review the same draft.'));
      const pair = node('div', 'review-pair'); element.append(heading, pair); entry.messages.append(element);
      group = { element, pair, sides: new Map() }; reviewGroups.set(key, group);
    }
    let side = group.sides.get(message.provider);
    if (!side) {
      const element = node('div', 'review-side'); element.dataset.provider = message.provider;
      const current = node('div', 'review-current');
      const previous = node('details', 'review-attempts'); previous.hidden = true;
      previous.append(node('summary', '', 'Earlier review attempt'));
      element.append(current, previous); group.pair.append(element);
      side = { element, current, previous }; group.sides.set(message.provider, side);
    }
    if (superseded) side.previous.hidden = false;
    return superseded ? side.previous : side.current;
  }
  function renderThread(run) {
    const turns = getTurns(run);
    const known = new Set(turns.map((turn) => turn.id));
    for (const [index, turn] of turns.entries()) {
      let entry = turnNodes.get(turn.id);
      if (!entry) {
        const element = node('section', 'chat-turn'); element.dataset.turnId = turn.id;
        const questionLabel = node('div', 'user-eyebrow', index === 0 ? 'YOUR QUESTION' : `FOLLOW-UP ${index}`);
        const user = node('div', 'user-message');
        const clarification = node('section', 'clarification-panel'); clarification.hidden = true; clarification.setAttribute('aria-label', 'Clarification questions');
        const messages = node('div', 'turn-messages');
        const final = node('section', 'final-message'); final.hidden = true;
        const error = node('div', 'turn-error'); error.setAttribute('role', 'alert'); error.hidden = true;
        const errorText = node('p', 'turn-error-text');
        const recovery = node('div', 'turn-recovery'); recovery.hidden = true;
        recovery.append(node('p', 'turn-recovery-note', 'Your question and files are saved. Reuse the question, or edit it before sending again.'));
        const retry = node('button', 'text-button retry-question', 'Use question again');
        retry.addEventListener('click', () => {
          const draft = currentDraft();
          if (draft.text.trim() && draft.text.trim() !== entry.user.textContent.trim()) return;
          draft.text = entry.user.textContent; draft.error = '';
          $('goal').value = draft.text; $('goal').focus();
          updateControls();
        });
        recovery.append(retry); error.append(errorText, recovery);
        element.append(questionLabel, user, clarification, messages, final, error); $('thread').append(element);
        entry = { element, user, clarification, messages, final, error, errorText, recovery, retry, separators: new Map() }; turnNodes.set(turn.id, entry);
      }
      const question = turn.question || turn.goal || (index === 0 ? run.goal : run.currentQuestion) || '';
      if (entry.user.textContent !== question) entry.user.textContent = question;
      const messages = (run.messages || []).filter((message) => {
        if (!message.turnId) return index === 0;
        return message.turnId === turn.id || (!known.has(message.turnId) && index === turns.length - 1);
      });
      renderClarification(run, turn, entry);
      const latestReviewIds = new Map();
      let reviewDraft = 0;
      for (const message of messages) {
        if (message.kind === 'candidate') reviewDraft++;
        if (message.kind === 'review') latestReviewIds.set(`${message.provider}:${draftVersion(message) || reviewDraft || 1}`, message.id);
      }
      let candidateNumber = 0;
      for (const message of messages) {
        // The dedicated context panel already displays the durable questions and answers.
        if (message.kind === 'clarification_answer' || (message.kind === 'clarification' && turn.clarification?.needsClarification && message.status !== 'failed')) continue;
        if (message.kind === 'candidate') {
          candidateNumber++;
          if (!entry.separators.has(message.id)) {
            const version = draftVersion(message) || candidateNumber;
            const separator = node('div', 'version-connector'); separator.dataset.version = version;
            separator.append(node('span', '', version === 1 ? 'Bringing the perspectives together' : 'Refining the answer'), node('strong', '', `Draft ${version}`));
            entry.messages.append(separator); entry.separators.set(message.id, separator);
          }
        }
        const superseded = message.kind === 'review' && latestReviewIds.get(`${message.provider}:${draftVersion(message) || candidateNumber || 1}`) !== message.id;
        const container = message.kind === 'review' ? reviewContainer(message, entry, turn, candidateNumber, superseded) : entry.messages;
        renderMessage(message, container, turn);
      }
      renderFinal(turn, entry);
      entry.error.hidden = !turn.error || turn.status === 'running';
      if (entry.errorText.textContent !== (turn.error || '')) entry.errorText.textContent = turn.error || '';
      entry.recovery.hidden = index !== turns.length - 1 || turn.status !== 'failed' || !!turn.plan || !messages.some((message) => ['clarification', 'plan', 'planning'].includes(message.kind) && message.status === 'failed');
    }
  }

  function renderView() {
    const run = selectedRun();
    const clarification = pendingClarification(run);
    document.querySelector('.composer-area').classList.toggle('is-clarifying', !!clarification);
    $('empty-state').hidden = !!run; $('thread').hidden = !run;
    $('chat-title').textContent = run?.goal || 'New chat';
    $('chat-title').title = run?.goal || '';
    $('export-run').hidden = !run;
    $('chat-status').hidden = !run;
    $('chat-status').textContent = run ? `${statusLabel(run.status)}${run.status === 'running' ? ` · ${elapsed(run)}` : ''}` : '';
    renderProgress(run);
    $('goal').placeholder = run ? 'Ask a follow-up…' : 'Ask Codex and Claude…';
    $('live-status').hidden = !run || run.status !== 'running';
    if (run?.status === 'running') $('live-status-text').textContent = `${phaseNames[run.phase] || 'Working through the question'}…`;
    $('run-error').hidden = !run?.storageWarning; $('run-error').textContent = run?.storageWarning || '';
    if (run) renderThread(run);
    renderSources(); updateControls();
    const panelKey = clarification ? `${run.id}:${clarification.id}` : null;
    if (panelKey && clarificationScrollKey !== panelKey) {
      clarificationScrollKey = panelKey; autoScroll = false; $('jump-latest').hidden = true;
      requestAnimationFrame(() => {
        if (state.selectedRunId !== run.id || pendingClarification()?.id !== clarification.id) return;
        const scroller = $('chat-scroll');
        const panel = [...turnNodes.values()].find(entry => entry.clarification.dataset.clarificationId === clarification.id)?.clarification;
        if (panel) scroller.scrollTop += panel.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24;
      });
    } else if (run && !clarification && autoScroll && !scrollScheduled) {
      scrollScheduled = true; const id = run.id;
      requestAnimationFrame(() => { scrollScheduled = false; if (autoScroll && state.selectedRunId === id) $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight; });
    }
  }

  function selectRun(id) {
    state.selectedRunId = id;
    state.defaultsMessage = '';
    messageNodes.clear(); turnNodes.clear(); reviewGroups.clear(); $('thread').replaceChildren();
    closePreview(); toggleSettings(false); autoScroll = true; clarificationScrollKey = null;
    $('goal').value = currentDraft().text;
    renderModels(); renderHistory(); renderView();
    if (!id) $('goal').focus();
  }

  function onRunUpdate(run) {
    if (!run?.id) return;
    const index = state.runs.findIndex((item) => item.id === run.id);
    const previous = state.runs[index]; if (olderSnapshot(run, previous)) return;
    if (index < 0) state.runs.unshift(run); else state.runs[index] = run;
    if (run.status === 'running') state.activeRunId = run.id; else if (state.activeRunId === run.id) state.activeRunId = null;
    renderHistory(); updateControls();
    if (state.selectedRunId === run.id) renderView();
    if (previous?.status === 'running' && run.status === 'completed') {
      const final = run.final || {};
      const moderated = Object.hasOwn(final, 'decided') || !!final.moderation;
      toast(final.consensus && (!moderated || final.decided) ? 'Both assistants agree. The final answer is ready.' : final.decided ? 'The moderator finalized the answer. Remaining disagreements are shown.' : 'The latest draft is ready with its review notes.');
    }
  }
  async function copyText(value) { try { await bridge.copyText(value); toast('Copied to clipboard'); } catch (error) { toast(errorText(error)); } }
  async function exportRun() { const run = selectedRun(); if (!run) return; try { const result = await bridge.exportRun(run.id); if (!result?.cancelled) toast('Chat exported'); } catch (error) { toast(errorText(error)); } }

  async function sendMessage(event) {
    event?.preventDefault();
    const draft = currentDraft(); const run = selectedRun();
    const ready = ['codex', 'claude'].every((provider) => state.providers[provider]?.available && state.providers[provider]?.compatible !== false && state.providers[provider]?.authenticated === true);
    if (!draft.text.trim() || pendingClarification(run) || state.starting || !state.preferencesLoaded || state.attachmentsBusy || providerSetupPending() || activeRun() || !ready || !moderatorAvailable() || sourceLimit()) return;
    const input = { goal: draft.text.trim(), attachmentIds: draft.files.map((file) => file.id), codexModel: draft.models.codex, claudeModel: draft.models.claude, moderatorModel: draft.models.moderator, timeoutMinutes: draft.timeoutMinutes };
    state.starting = true; draft.error = ''; updateControls(); renderModels();
    try {
      const updated = run ? await bridge.followUp(run.id, input) : await bridge.startRun(input);
      draft.text = ''; draft.files = []; draft.errors = []; draft.error = '';
      onRunUpdate(updated);
      const nextDraft = currentDraft(updated.id);
      nextDraft.models = { ...draft.models }; nextDraft.timeoutMinutes = draft.timeoutMinutes;
      if (!run) state.drafts.delete('__new__');
      selectRun(updated.id);
    } catch (error) { draft.error = errorText(error); }
    finally { state.starting = false; renderModels(); renderSources(); updateControls(); }
  }

  $('goal-form').addEventListener('submit', sendMessage);
  $('goal').addEventListener('input', () => { currentDraft().text = $('goal').value; updateControls(); });
  $('new-chat').addEventListener('click', () => selectRun(null));
  for (const button of document.querySelectorAll('.sample-prompt')) button.addEventListener('click', () => {
    const draft = currentDraft();
    if (draft.text.trim()) { $('goal').focus(); return; }
    draft.text = button.dataset.prompt; $('goal').value = draft.text; $('goal').focus(); updateControls();
  });
  $('view-active').addEventListener('click', () => { const run = activeRun(); if (run) selectRun(run.id); });
  $('attach-files').addEventListener('click', pickSources);
  $('clear-attachment-errors').addEventListener('click', () => { currentDraft().errors = []; renderSources(); });
  $('settings-toggle').addEventListener('click', () => toggleSettings());
  $('close-settings').addEventListener('click', () => toggleSettings(false));
  $('close-source-preview').addEventListener('click', closePreview);
  $('refresh-models').addEventListener('click', () => refreshModels(true));
  for (const provider of ['codex', 'claude', 'moderator']) $(`${provider}-model`).addEventListener('change', () => { currentDraft().models[provider] = $(`${provider}-model`).value; settingsChanged(); });
  $('timeout-minutes').addEventListener('change', () => { currentDraft().timeoutMinutes = Number($('timeout-minutes').value); settingsChanged(); });
  $('save-defaults').addEventListener('click', saveDefaults);
  $('export-run').addEventListener('click', exportRun);
  $('stop-active-run').addEventListener('click', async () => {
    const run = activeRun() || (pendingClarification() ? selectedRun() : null); if (!run) return; $('stop-active-run').disabled = true;
    try { const result = await bridge.stopRun(run.id); if (result?.id) onRunUpdate(result); }
    catch (error) { toast(errorText(error)); updateControls(); }
  });
  $('refresh-providers').addEventListener('click', () => refreshConnections());
  $('open-connections').addEventListener('click', () => openConnections());
  $('close-connections').addEventListener('click', closeConnections);
  $('done-connections').addEventListener('click', closeConnections);
  $('refresh-connections').addEventListener('click', () => refreshConnections());
  $('connections-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeConnections(); });
  $('connections-dialog').addEventListener('close', () => { const target = connectionsReturnFocus?.isConnected ? connectionsReturnFocus : $('open-connections'); target.focus(); connectionsReturnFocus = null; });
  $('chat-scroll').addEventListener('scroll', () => {
    const scroller = $('chat-scroll'); autoScroll = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
    $('jump-latest').hidden = autoScroll || !selectedRun() || !!pendingClarification();
  }, { passive: true });
  $('jump-latest').addEventListener('click', () => { autoScroll = true; $('chat-scroll').scrollTo({ top: $('chat-scroll').scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); $('jump-latest').hidden = true; });
  document.addEventListener('keydown', (event) => {
    if ($('connections-dialog').open) { if (event.key === 'Escape') { event.preventDefault(); closeConnections(); } return; }
    if (event.key === 'Escape') { closePreview(); toggleSettings(false); }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); const clarification = pendingClarification(); if (clarification) answerClarification(state.selectedRunId, clarification, false); else sendMessage(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); selectRun(null); }
  });
  $('reload-app').addEventListener('click', () => window.location.reload());
  window.addEventListener('beforeunload', () => { unsubscribeRun?.(); unsubscribeProviders?.(); });
  setInterval(() => { const run = selectedRun(); if (run?.status === 'running') $('chat-status').textContent = `${statusLabel(run.status)} · ${elapsed(run)}`; }, 1000);

  async function initialize() {
    renderProviders(); renderHistory(); renderSources();
    try {
      if (!bridge) throw new Error('Open AI Collab from the desktop app. The desktop bridge is unavailable in a browser.');
      unsubscribeRun = bridge.onRunUpdate(onRunUpdate);
      unsubscribeProviders = bridge.onProviders(receiveProviders);
      void refreshModels();
      const initial = await bridge.getState();
      receivePreferences(initial.preferences, true);
      state.defaultsError = initial.preferencesWarning || '';
      const received = new Map(state.runs.map((run) => [run.id, run]));
      state.runs = (initial.runs || []).map((run) => olderSnapshot(run, received.get(run.id)) ? received.get(run.id) : run);
      for (const [id, run] of received) if (!state.runs.some((item) => item.id === id)) state.runs.push(run);
      state.providers = initial.providers || state.providers;
      state.activeRunId = state.runs.find((run) => run.status === 'running')?.id || initial.activeRunId || null;
      renderProviders(); selectRun(activeRun()?.id || null);
      if (['codex', 'claude'].some((provider) => !state.providers[provider]?.available || state.providers[provider]?.compatible === false || state.providers[provider]?.authenticated !== true)) openConnections();
    } catch (error) { $('boot-error').hidden = false; $('boot-error-message').textContent = errorText(error); }
  }
  initialize();
})();
