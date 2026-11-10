const $ = s => document.querySelector(s);
const token = $('meta[name="launchkit-session"]').content;
let selected;
let operationsFormRun;
let refreshVersion = 0;
let cloudFormRun;
let cloudReportRun;
let cloudRefreshing = false;
let growthOptionsKey;
let growthBusy = false;
let googleConnectionKey;
let bingOptionsKey;
let socialDraftId;
let socialFormRun;
let socialRenderKey;
let socialBusy = false;
async function api(path, body) {
  const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-LaunchKit-Token': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || 'Request failed'); return result;
}
const notice = message => { $('#notice').textContent = message; };
function button(text, action) { const el = document.createElement('button'); el.textContent = text; el.onclick = () => action().catch(e => notice(e.message)); return el; }
async function refresh() {
  const version = ++refreshVersion;
  const [status, runs, selection] = await Promise.all([api('/status'), api('/runs'), api('/selection')]);
  if (version !== refreshVersion) return;
  if (status.backgroundError) notice(status.backgroundError);
  $('#connection-status').textContent = status.connections.cloudflare ? 'Cloudflare connected · local operator' : 'Connect accounts to go live';
  renderConnections(status);
  const supportsM3b = !!status.bing;
  if (!status.social) $('#social-grow').hidden = true;
  $('#social-storage').textContent = status.social ? `${status.social.connected ? 'Saved token restored.' : 'Not connected.'} Storage: ${status.social.persistence}. Verify the account before preparing a post.` : 'Restart LaunchKit to enable social publishing.';
  if (!supportsM3b) {
    $('#bing-grow').hidden = true; $('#discoverability').hidden = true;
    notice('LaunchKit was updated while the local server was running. Restart LaunchKit to enable Bing and public discoverability. Your saved businesses and connections are preserved.');
  }
  $('#history').replaceChildren(...runs.filter(run => !run.resources.supersededBy).map(run => {
    const deployed = run.resources.url === `https://${run.config.domain}`;
    const label = run.config.mode === 'mock' ? 'Simulation' : deployed ? (run.status === 'LIVE_VERIFIED' ? 'Verified production' : 'Production · needs attention') : 'Draft · not deployed';
    const entry = button(`${run.config.domain} · ${label} · ${run.id.slice(0, 8)}`, async () => { await api('/selection', { selectedRunId: run.id }); await refresh(); });
    entry.dataset.runId = run.id; entry.setAttribute('aria-pressed', String(run.id === selection.selectedRunId)); return entry;
  }));
  if (selected !== selection.selectedRunId) {
    selected = selection.selectedRunId; cloudReportRun = undefined; cloudFormRun = undefined; operationsFormRun = undefined;
    $('#cloud-status').textContent = 'Loading cloud status for the selected business…';
    $('#cloud-target').textContent = ''; $('#cloud-evidence').textContent = ''; $('#cloud-incidents').replaceChildren();
    $('#cloud-verification').textContent = ''; $('#cloud-release').textContent = '';
    $('#sync-cloud-release').hidden = true; $('#grow').hidden = true; $('#operate').hidden = true;
    $('#bing-grow').hidden = true; $('#discoverability').hidden = true;
    const selectedRun = runs.find(r => r.id === selected); if (selectedRun) fill(selectedRun.config);
    $('#social-grow').hidden = true; socialFormRun = undefined; socialRenderKey = undefined; resetSocialEditor();
  }
  if (!selected) return;
  const run = runs.find(r => r.id === selected); if (!run) return;
  $('#operate-title').textContent = `Operate · ${run.config.domain}`;
  $('#progress').hidden = false; $('#run-title').textContent = run.config.domain;
  $('#run-status').textContent = `${run.config.mode === 'mock' ? 'SIMULATION — ' : ''}${run.status.replaceAll('_', ' ')}`;
  $('#website').textContent = run.resources.url || ''; $('#website').removeAttribute('href');
  if (run.resources.url && run.config.mode === 'live') $('#website').href = run.resources.url;
  $('#resume').disabled = status.active;
  $('#configure-analytics').disabled = status.active || run.config.mode !== 'live' || run.resources.url !== `https://${run.config.domain}`;

  $('#steps').replaceChildren(...Object.entries(run.steps).map(([name, step]) => {
    const li = document.createElement('li'); li.dataset.status = step.status;
    const title = document.createElement('strong'); title.textContent = `${name === 'analytics' && step.evidence?.configurationVerified ? 'Cloudflare Web Analytics: Enabled' : name} · ${step.status.replaceAll('_', ' ')}`; li.append(title);
    const p = document.createElement('p'); p.textContent = step.message || step.evidence?.message || ''; li.append(p);
    if (step.evidence?.actionURL) {
      try { const url = new URL(step.evidence.actionURL); if (url.protocol === 'https:' && ['dash.cloudflare.com', 'resend.com'].includes(url.hostname)) { const a = document.createElement('a'); a.href = url.href; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = name === 'analytics' ? 'Open Cloudflare analytics dashboard' : 'Open provider setup ↗'; li.append(a); } } catch { /* No unvalidated external links. */ }
    }
    if (step.evidence) { const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Verification evidence'; const pre = document.createElement('pre'); pre.textContent = JSON.stringify(step.evidence, null, 2); details.append(summary, pre); li.append(details); }
    return li;
  }));
  $('#approvals').replaceChildren(...run.approvals.filter(a => !a.decision && Object.values(run.steps).some(step => step.evidence?.approvalId === a.id)).map(a => {
    const div = document.createElement('div'); div.className = 'approval'; const title = document.createElement('h3'); title.textContent = `Approval required: ${a.kind}`;
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(a.details, null, 2);
    div.append(title, pre, button('Approve exact action', async () => { await api(`/runs/${run.id}/approval`, { approvalId: a.id, decision: 'approved' }); await refresh(); }), button('Decline', async () => { await api(`/runs/${run.id}/approval`, { approvalId: a.id, decision: 'denied' }); await refresh(); })); return div;
  }));
  const operations = await api(`/runs/${run.id}/operate`);
  if (version !== refreshVersion || selected !== run.id) return;
  renderOperations(operations, status.active);
  $('#cloud-operate').hidden = run.config.mode !== 'live';
  if (run.config.mode === 'live' && cloudReportRun !== run.id && !cloudRefreshing) void refreshCloud();
  for (const id of ['deploy-cloud', 'save-cloud', 'disable-cloud', 'verify-cloud', 'sync-cloud-release']) {
    $(`#${id}`).disabled = status.active || !operations.eligible || cloudReportRun !== run.id;
    $(`#${id}`).title = status.active ? 'Wait for the current operation to finish.' : !operations.eligible ? 'Select the deployed business in Saved businesses; this entry is a draft.' : cloudReportRun !== run.id ? 'Wait for this business’s cloud status to load.' : '';
  }
  const growth = await api(`/runs/${run.id}/grow`);
  if (version === refreshVersion && selected === run.id) renderGrowth(growth, status.active);
  if (status.social) {
    const social = await api(`/runs/${run.id}/grow/social`);
    if (version === refreshVersion && selected === run.id) renderSocial(social, status.active);
  }
  if (!supportsM3b) return;
  const [bing, audit, improvements] = await Promise.all([api(`/runs/${run.id}/grow/bing`), api(`/runs/${run.id}/grow/audit`), api(`/runs/${run.id}/grow/improvements`)]);
  if (version === refreshVersion && selected === run.id) { renderBing(bing, status.active); renderAudit(audit, status.active); renderImprovements(improvements, status.active); }
}
function resetSocialEditor(draft) {
  socialDraftId = draft?.id; $('#social-text').value = draft?.text || ''; $('#social-visibility').value = draft?.visibility || 'unlisted';
  $('#social-editor-title').textContent = draft ? 'Edit saved draft' : 'New draft';
}
function renderSocial(report, active = false) {
  $('#social-grow').hidden = false;
  if (socialFormRun !== report.runId) { resetSocialEditor(); socialFormRun = report.runId; }
  if (report.drafts.some(d => d.id === socialDraftId && ['UNKNOWN', 'ACCEPTED', 'OBSERVED'].includes(d.status))) resetSocialEditor();
  $('#social-title').textContent = `Social publishing · ${report.domain}`;
  $('#social-status').textContent = `${report.simulated ? 'SIMULATION · no public posts · ' : ''}${report.account ? `@${report.account.username}@mastodon.social · verified ${time(report.checkedAt)} · limit ${report.account.maxCharacters} characters` : report.connected ? 'Token saved; verify the publishing account.' : 'Connect your mastodon.social account.'}`;
  $('#social-limits').textContent = report.limits;
  const reason = active || socialBusy ? 'Wait for the current operation to finish.' : !report.eligible ? 'Select a bound business before preparing posts.' : '';
  for (const id of ['save-social', 'template-social', 'refresh-social']) disabledReason(id, reason);
  for (const id of ['new-social', 'download-social']) disabledReason(id, socialBusy ? 'Wait for the current operation to finish.' : '');
  disabledReason('connect-social', active || socialBusy ? 'Wait for the current operation to finish.' : '');
  const key = JSON.stringify([report.runId, report.drafts, report.connected, reason]); if (key === socialRenderKey) return; socialRenderKey = key;
  $('#social-drafts').replaceChildren(...[...report.drafts].reverse().map(d => {
    const card = document.createElement('section'); card.className = 'social-draft'; card.dataset.draftId = d.id;
    const title = document.createElement('h4'); title.textContent = `${d.status.replaceAll('_', ' ')} · ${d.visibility} · ${time(d.createdAt)}`;
    const preview = document.createElement('pre'); preview.textContent = d.text; card.append(title, preview);
    const a = d.approvals.at(-1);
    const add = (label, action, disabled = reason) => { const control = button(label, action); control.disabled = !!disabled; control.title = disabled; card.append(control); return control; };
    if (['DRAFT', 'AWAITING_APPROVAL', 'DECLINED'].includes(d.status)) {
      add('Edit draft', async () => { resetSocialEditor(d); $('#social-text').focus(); });
      add('Prepare exact post approval', () => socialAction('prepare', { draftId: d.id }, report.runId), reason || (!report.connected ? 'Connect a publishing account.' : ''));
    }
    if (d.status === 'AWAITING_APPROVAL' && a) {
      const target = document.createElement('p'); target.textContent = `Exact destination: @${a.account.username}@mastodon.social (account ${a.account.id}) · ${d.visibility}. Content hash: ${a.hash}`; card.append(target);
      if (d.approvalValid) add('Approve and publish exact post', () => socialAction('approval', { draftId: d.id, approvalId: a.id, decision: 'approved' }, report.runId));
      else { const changed = document.createElement('p'); changed.textContent = 'Connection or business changed. Prepare a new approval.'; card.append(changed); }
      add('Decline post', () => socialAction('approval', { draftId: d.id, approvalId: a.id, decision: 'denied' }, report.runId));
    }
    if (['UNKNOWN', 'ACCEPTED', 'OBSERVED'].includes(d.status)) {
      const message = document.createElement('p'); message.textContent = d.message || 'Interrupted attempt: outcome unknown. Inspect your account; this draft will not be resent.'; card.append(message);
      if (d.publication) {
        const evidence = document.createElement('p'); evidence.textContent = `${report.simulated ? 'Simulated' : 'Provider'} post ${d.publication.id} · ${time(d.publication.createdAt)}${d.observedAt ? ` · source observed ${time(d.observedAt)}` : ''}`; card.append(evidence);
        if (!report.simulated && /^https:\/\/mastodon\.social\/@[a-zA-Z0-9_]+\/\d+$/.test(d.publication.url)) { const link = document.createElement('a'); link.href = d.publication.url; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = 'Inspect published post'; card.append(link); }
      }
      const post = document.createElement('input'); post.inputMode = 'numeric'; post.setAttribute('aria-label', 'Post ID to reconcile');
      if (!d.publication) { const label = document.createElement('label'); label.textContent = 'Numeric post ID from your Mastodon post URL'; label.append(post); card.append(label); }
      add('Reconcile publication (read only)', () => socialAction('reconcile', { draftId: d.id, postId: post.value }, report.runId));
    }
    const history = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Approval and publication evidence'; const evidence = document.createElement('pre'); evidence.textContent = JSON.stringify(d, null, 2); history.append(summary, evidence); card.append(history);
    return card;
  }));
}
async function socialAction(action, body = {}, id = selected) {
  if (!id || socialBusy) return;
  socialBusy = true;
  $('#social-grow').querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const result = await api(`/runs/${id}/grow/social/${action}`, body);
    if (selected === id) {
      if (result.savedDraftId) resetSocialEditor(result.drafts.find(d => d.id === result.savedDraftId));
      notice(action === 'approval' ? 'Publication decision saved. Inspect the outcome in history.' : 'Social changes saved.');
    }
  } finally { socialBusy = false; socialRenderKey = undefined; await refresh(); $('#new-social').disabled = false; }
}
$('#social-connect-form').onsubmit = event => { event.preventDefault(); const input = $('[name=mastodonToken]'); const value = input.value; input.value = ''; api('/grow/social/connect', { accessToken: value }).then(refresh).catch(e => notice(e.message)); };
$('#social-draft-form').onsubmit = event => { event.preventDefault(); socialAction('save', { draftId: socialDraftId, text: $('#social-text').value, visibility: $('#social-visibility').value }).catch(e => notice(e.message)); };
$('#new-social').onclick = () => resetSocialEditor();
$('#template-social').onclick = () => socialAction('template').catch(e => notice(e.message));
$('#refresh-social').onclick = () => socialAction('refresh').catch(e => notice(e.message));
$('#download-social').onclick = async () => { try { const report = await api(`/runs/${selected}/grow/social`); const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'launchkit-social.json'; a.click(); URL.revokeObjectURL(url); } catch (e) { notice(e.message); } };
function renderConnections(status) {
  const google = status.google;
  $('#bing-storage').textContent = status.bing ? `Bing: ${status.bing.connected ? 'Saved key restored; no key entry needed.' : 'Not connected.'} Storage: ${status.bing.persistence}.` : 'Restart LaunchKit to load Bing support.';
  $('#saved-connections').textContent = `Cloudflare: ${status.connections.cloudflare ? 'saved connection restored — no token entry needed' : 'not connected'}. Google: ${google.connected ? 'saved authorization restored' : google.configured ? 'client saved; consent needed' : 'not connected'}. Storage: ${status.connections.persistence}.`;
  $('[name=cloudflare]').placeholder = status.connections.cloudflare ? 'Saved securely — leave blank to keep' : 'Enter a scoped Cloudflare token';
  $('[name=googleClientId]').placeholder = google.configured ? 'Saved client — leave blank to reuse' : 'Your Desktop OAuth client ID';
  $('[name=googleClientSecret]').placeholder = google.configured ? 'Saved securely — leave blank to reuse' : 'Your Desktop OAuth client secret';
  $('#google-storage').textContent = `${google.connected ? 'Google authorization is saved. Refresh Growth directly; no new sign-in or launch is needed.' : google.configured ? 'The Google client is saved. Continue sign-in using the saved client.' : 'Connect a customer-owned Google Desktop OAuth client once.'} Storage: ${google.persistence}.`;
  $('#connect-google').textContent = google.connected ? 'Reconnect / change Google consent' : 'Prepare Google sign-in';
  const key = JSON.stringify(google);
  if (googleConnectionKey !== key) { $('[name=googleManage]').checked = google.writable; $('#google-signin').hidden = true; googleConnectionKey = key; }
}
function disabledReason(id, reason) { const control = $(`#${id}`); control.disabled = !!reason; control.title = reason; }
function renderGrowth(report, active = false) {
  $('#grow').hidden = false;
  $('#grow-title').textContent = `Growth · ${report.domain}`;
  $('#growth-status').textContent = `${report.simulated ? 'SIMULATION · no Google requests · ' : 'Google Search Console · '}${report.connected ? (report.writable ? 'Sitemap management authorized' : 'Read-only connection') : 'Customer authorization needed'} · ${report.stale ? 'NOT REFRESHED / STALE' : 'Saved evidence'} · ${time(report.refreshedAt)}`;
  const properties = report.properties?.status === 'AVAILABLE' ? report.properties.data : [];
  const key = JSON.stringify([report.runId, properties, report.property]);
  if (key !== growthOptionsKey) {
    growthOptionsKey = key;
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Select an accessible property';
    $('#growth-property').replaceChildren(empty, ...properties.map(site => { const option = document.createElement('option'); option.value = site.siteUrl; option.textContent = `${site.siteUrl} · ${site.permissionLevel}`; return option; }));
    $('#growth-property').value = report.property || '';
  }
  $('#search-console').href = report.propertyURL;
  $('#growth-window').textContent = report.window ? `${report.window.startDate} to ${report.window.endDate} inclusive · Pacific Time · final web-search data · selected property: ${report.property}` : 'Select a property and refresh to read its reporting window.';
  const performance = report.performance;
  $('#growth-metrics').textContent = performance?.status === 'AVAILABLE' ? `${report.simulated ? 'Simulated: ' : 'Google reports: '}${performance.data.clicks.toLocaleString()} clicks · ${performance.data.impressions.toLocaleString()} impressions · ${(performance.data.ctr * 100).toFixed(2)}% CTR · ${performance.data.position.toFixed(1)} average position` : performance?.message || 'Search metrics unavailable until refreshed.';
  $('#growth-measurement').textContent = report.measurement;
  const maps = report.sitemaps;
  $('#growth-sitemaps').replaceChildren(...(maps?.status === 'AVAILABLE' ? (maps.data.length ? maps.data.map(map => item(`${map.path} · ${map.isPending === true ? 'PROCESSING PENDING' : map.isPending === false ? 'Not pending' : 'Processing status unavailable'} · errors ${map.errors ?? 'unavailable'} · warnings ${map.warnings ?? 'unavailable'} · submitted ${map.lastSubmitted ? time(map.lastSubmitted) : 'unavailable'} · downloaded ${map.lastDownloaded ? time(map.lastDownloaded) : 'unavailable'}`)) : [item('No sitemaps returned for this property.')]) : [item(maps?.message || 'Sitemap evidence unavailable until refreshed.')]));
  $('#growth-indexing').textContent = report.indexing;
  $('#growth-actions').replaceChildren(...report.nextActions.map(item));
  $('#growth-evidence').textContent = JSON.stringify(report, null, 2);
  $('#growth-approvals').replaceChildren(...report.submissions.filter(a => !report.connectionChanged && a.connection === report.connection && a.property === report.property && a.status === 'AWAITING_APPROVAL').map(action => {
    const div = document.createElement('div'); div.className = 'approval';
    const p = document.createElement('p'); p.textContent = `${report.simulated ? 'SIMULATED action: ' : ''}Submit ${action.sitemap} to Google property ${action.property}. This does not edit your website or guarantee indexing.`;
    const approve = button('Approve exact sitemap submission', () => growthAction('approval', { approvalId: action.id, decision: 'approved' }));
    const decline = button('Decline sitemap submission', () => growthAction('approval', { approvalId: action.id, decision: 'denied' }));
    approve.disabled = decline.disabled = active || growthBusy; div.append(p, approve, decline); return div;
  }));
  const reason = active ? 'Wait for the current launch or operations check to finish.' : growthBusy ? 'A Growth request is in progress.' : !report.eligible ? 'This saved entry is a draft without a bound production website. Select the existing verified production entry in Saved businesses; do not launch it again.' : !report.connected ? 'Connect Google using the form below before refreshing properties.' : '';
  disabledReason('refresh-growth', reason);
  disabledReason('select-growth-property', reason || (!properties.length ? 'Refresh Google properties first; if none are returned, verify property access in Search Console.' : ''));
  const submissionReason = reason || (!report.property ? 'Select a property before preparing sitemap submission.' : !report.writable ? 'Sitemap submission needs management consent; read-only Growth refresh is already available.' : !report.sitemapReady ? 'The M1 SEO/sitemap step must be verified before submission.' : '');
  disabledReason('prepare-sitemap', submissionReason);
  disabledReason('connect-google', active || growthBusy ? 'Wait for the current operation to finish.' : report.simulated ? 'Simulation does not use Google authorization. Select a live business to connect.' : '');
  $('#growth-disabled').textContent = reason || submissionReason;
}
async function growthAction(action, body = {}) {
  if (growthBusy) return;
  const id = selected; growthBusy = true;
  try { notice('Reading or updating Growth evidence…'); const report = await api(`/runs/${id}/grow/${action}`, body); if (selected === id) renderGrowth(report); notice('Growth evidence saved. Review statuses and any exact-action approval below.'); }
  finally { growthBusy = false; await refresh(); }
}
$('#refresh-growth').onclick = () => growthAction('refresh').catch(e => notice(e.message));
$('#prepare-sitemap').onclick = () => growthAction('prepare').catch(e => notice(e.message));
$('#growth-property-form').onsubmit = event => { event.preventDefault(); growthAction('select', { property: $('#growth-property').value }).catch(e => notice(e.message)); };
$('#download-growth').onclick = () => download(`/runs/${selected}/grow`, 'launchkit-growth.json');
$('#google-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const result = await api('/grow/google/connect', { clientId: $('[name=googleClientId]').value, clientSecret: $('[name=googleClientSecret]').value, manageSitemaps: $('[name=googleManage]').checked });
    $('[name=googleClientSecret]').value = '';
    $('#google-signin').href = result.url; $('#google-signin').hidden = false;
    const status = await api('/grow/google'); $('#google-storage').textContent = `Credential storage: ${status.persistence}. Authorization link expires in ten minutes. Return here after consent, then refresh Google properties.`;
    notice('Continue using the Google sign-in link. Google may require you to configure the consent screen and add your account as a test user.');
  } catch (e) { notice(e.message); }
};
function cloudInput() { return { enabled: $('[name=cloudEnabled]').checked, intervalMinutes: Number($('[name=cloudInterval]').value), notifications: $('[name=cloudNotifications]').checked, authorized: $('[name=cloudAuthorized]').checked }; }
function renderBing(report, active = false) {
  $('#bing-grow').hidden = false;
  $('#bing-title').textContent = `Growth · Bing · ${report.domain}`;
  $('#bing-status').textContent = `${report.simulated ? 'SIMULATION · no Bing requests' : 'Bing Webmaster Tools'} · ${report.connected ? 'Connected' : 'API key needed'} · ${report.stale ? 'NOT REFRESHED / STALE' : 'Saved evidence'} · ${time(report.refreshedAt)}`;
  const properties = report.properties?.status === 'AVAILABLE' ? report.properties.data : [];
  const key = JSON.stringify([report.runId, properties, report.property]);
  if (key !== bingOptionsKey) {
    bingOptionsKey = key;
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Select a verified HTTPS site';
    $('#bing-property').replaceChildren(empty, ...properties.map(site => { const option = document.createElement('option'); option.value = site.siteUrl; option.textContent = site.siteUrl; return option; }));
    $('#bing-property').value = report.property || '';
  }
  $('#bing-measurement').textContent = report.measurement;
  const performance = report.performance;
  const rows = performance?.status === 'AVAILABLE' ? performance.data.rows : [];
  $('#bing-metrics-status').textContent = performance?.status === 'AVAILABLE' ? `${report.simulated ? 'Simulated' : 'Bing-reported'}: ${rows.length} rows · ${rows[0].date} to ${rows.at(-1).date} · retrieved ${time(performance.at)}. Latest 28 rows shown; download includes all returned rows.` : `${performance?.status || 'UNAVAILABLE'} · ${performance?.message || 'Select a site and refresh Bing evidence.'}`;
  $('#bing-metrics').replaceChildren(...rows.slice(-28).map(r => item(`${r.date} · ${r.clicks.toLocaleString()} clicks · ${r.impressions.toLocaleString()} impressions`)));
  const maps = report.sitemaps;
  $('#bing-sitemaps').replaceChildren(...(maps?.status === 'AVAILABLE' ? (maps.data.length ? maps.data.map(m => item(`${m.path} · provider status ${m.providerStatus ?? 'unavailable'} · feed URLs ${m.urlCount ?? 'unavailable'} · submitted ${m.lastSubmitted ? time(m.lastSubmitted) : 'unavailable'} · crawled ${m.lastCrawled ? time(m.lastCrawled) : 'unavailable'}`)) : [item('No sitemaps returned for this site.')]) : [item(maps?.message || 'Sitemap evidence unavailable until refreshed.')]));
  $('#bing-indexing').textContent = report.indexing;
  $('#bing-actions').replaceChildren(...report.nextActions.map(item));
  $('#bing-evidence').textContent = JSON.stringify(report, null, 2);
  $('#bing-approvals').replaceChildren(...report.submissions.filter(a => !report.connectionChanged && a.connection === report.connection && a.property === report.property && a.status === 'AWAITING_APPROVAL').map(a => {
    const div = document.createElement('div'); div.className = 'approval'; const p = document.createElement('p');
    p.textContent = `${report.simulated ? 'SIMULATED: ' : ''}Submit ${a.sitemap} to Bing site ${a.property}. Submission does not guarantee processing or indexing.`;
    const approve = button('Approve exact Bing sitemap submission', () => m3bAction('bing/approval', { approvalId: a.id, decision: 'approved' }));
    const decline = button('Decline Bing submission', () => m3bAction('bing/approval', { approvalId: a.id, decision: 'denied' }));
    approve.disabled = decline.disabled = active || growthBusy; div.append(p, approve, decline); return div;
  }));
  const reason = active || growthBusy ? 'Wait for the current operation to finish.' : !report.eligible ? 'Select a bound production business in Saved businesses.' : !report.connected ? 'Connect Bing using your Webmaster API key.' : '';
  disabledReason('refresh-bing', reason);
  disabledReason('select-bing', reason || (!properties.length ? 'Refresh Bing and verify access to your HTTPS site first.' : ''));
  disabledReason('prepare-bing', reason || (!report.property ? 'Select a verified Bing site first.' : !report.sitemapReady ? 'Verify the approved M1 sitemap before submission.' : ''));
  disabledReason('connect-bing', active || growthBusy ? 'Wait for the current operation.' : report.simulated ? 'Simulation does not use Bing credentials.' : '');
  $('#bing-disabled').textContent = reason;
}
function renderAudit(report, active = false) {
  $('#discoverability').hidden = false;
  $('#audit-title').textContent = `Public discoverability · ${report.domain}`;
  $('#audit-status').textContent = `${report.simulated ? 'SIMULATION · no public requests · ' : ''}${report.stale ? 'NOT REFRESHED / STALE' : 'Saved observations'} · ${time(report.at)}`;
  $('#audit-limits').textContent = report.limits;
  const finding = f => {
    const li = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = `${f.priority || (f.status === 'OBSERVED' ? 'P3' : 'P2')} · ${f.policy || f.status} · ${f.check}${f.purpose ? ` · ${f.purpose === 'TRAINING' ? 'Training control' : 'Search crawler'}` : ''}`;
    li.append(title);
    const source = { STATIC_HTML: 'Initial HTML evidence', RENDERED_PAGE: 'JavaScript-rendered evidence', ROBOTS_POLICY: 'Robots policy interpretation', PUBLIC_ENDPOINT: 'Public endpoint evidence' }[f.source] || 'Earlier public audit evidence';
    for (const [text, className] of [[`${source}${f.assessment ? ' · Heuristic assessment — REVIEW' : ' · Observation'} · ${f.url} · ${time(f.at)}`, 'hint'], [f.evidence, ''], [f.why ? `Why it may matter: ${f.why}` : '', ''], [f.action ? `Human review: ${f.action}` : '', '']]) {
      if (!text) continue;
      const p = document.createElement('p'); p.className = className; p.textContent = text; li.append(p);
    }
    return li;
  };
  const sorted = [...report.findings].sort((a, b) => (a.priority || 'P2').localeCompare(b.priority || 'P2'));
  const review = sorted.filter(f => f.status !== 'OBSERVED');
  $('#audit-findings').replaceChildren(...(review.length ? review.map(finding) : [item(report.at ? 'No review items recorded. Supporting observations do not establish indexing or citations.' : 'Run the explicit public audit to collect evidence.')]));
  const groups = [
    ['Initial HTML content', f => f.source === 'STATIC_HTML'],
    ['JavaScript-rendered content', f => f.source === 'RENDERED_PAGE'],
    ['Search crawler access policy', f => f.purpose === 'SEARCH'],
    ['Model-training crawler policy', f => f.purpose === 'TRAINING'],
    ['Other public endpoint observations', f => !['STATIC_HTML', 'RENDERED_PAGE'].includes(f.source) && !f.purpose]
  ].flatMap(([label, matches]) => {
    const observations = sorted.filter(f => f.status === 'OBSERVED' && matches(f));
    if (!observations.length) return [];
    const heading = document.createElement('h4'); heading.textContent = label;
    const list = document.createElement('ul'); list.replaceChildren(...observations.map(finding));
    return [heading, list];
  });
  $('#audit-observations').replaceChildren(...groups);
  disabledReason('refresh-audit', active || growthBusy ? 'Wait for the current operation.' : !report.eligible ? 'Select a bound production business first.' : '');
}
async function m3bAction(action, body = {}) {
  if (growthBusy) return;
  const id = selected; growthBusy = true;
  try {
    notice('Reading or updating Growth evidence…');
    const report = await api(`/runs/${id}/grow/${action}`, body);
    if (selected === id) { if (action.startsWith('bing/')) renderBing(report); else renderAudit(report); }
    notice('Evidence saved. Review observations and any exact-action approval.');
  } finally { growthBusy = false; await refresh(); }
}
$('#refresh-bing').onclick = () => m3bAction('bing/refresh').catch(e => notice(e.message));
$('#prepare-bing').onclick = () => m3bAction('bing/prepare').catch(e => notice(e.message));
$('#bing-property-form').onsubmit = event => { event.preventDefault(); m3bAction('bing/select', { property: $('#bing-property').value }).catch(e => notice(e.message)); };
$('#bing-form').onsubmit = async event => {
  event.preventDefault();
  try { await api('/grow/bing/connect', { apiKey: $('[name=bingApiKey]').value }); $('[name=bingApiKey]').value = ''; await refresh(); notice('Bing key saved. Refresh Bing properties to verify access.'); }
  catch (e) { notice(e.message); }
};
$('#refresh-audit').onclick = () => m3bAction('audit/refresh').catch(e => notice(e.message));
$('#download-bing').onclick = () => download(`/runs/${selected}/grow/bing`, 'launchkit-bing-growth.json');
$('#download-audit').onclick = () => download(`/runs/${selected}/grow/audit`, 'launchkit-discoverability.json');
let improvementRun;
function renderImprovements(report, active = false) {
  if (improvementRun !== report.runId) { $('#improvement-title').value = ''; improvementRun = report.runId; }
  $('#improvement-limits').textContent = `${report.simulated ? 'SIMULATION. ' : ''}${report.owner} ${report.limits}`;
  const unresolved = report.proposals.some(p => ['INTENT', 'UNKNOWN', 'PUBLISHED'].includes(p.status));
  disabledReason('prepare-improvement', active || growthBusy ? 'Wait for the current operation.' : !report.eligible ? 'Select a bound business.' : unresolved ? 'Verify the unresolved publication first.' : '');
  $('#improvement-history').replaceChildren(...report.proposals.slice().reverse().map(p => {
    const card = document.createElement('div'); card.className = 'approval';
    const title = document.createElement('h4'); title.textContent = `${p.stale ? 'STALE' : p.status} · ${p.title}`;
    const source = document.createElement('p'); source.textContent = `Before: https://${report.domain}/ · ${time(p.beforeAt)}. ${p.message || 'Review the exact title edit and source evidence before approval.'}`;
    const pre = document.createElement('pre'); pre.textContent = p.changes.map(c => `Before: ${c.before}\nAfter:  ${c.after}`).join('\n\n');
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Before / after evidence';
    const proof = document.createElement('pre'); proof.textContent = JSON.stringify({ before: p.before, after: p.after || 'Not measured. Publication and follow-up audit require explicit actions.' }, null, 2); details.append(summary, proof);
    card.append(title, source, pre, details);
    const action = (label, name) => {
      const b = button(label, () => improvementAction(name, { proposalId: p.id, previewHash: p.previewHash })); b.disabled = active || growthBusy;
      if (name === 'publish') { b.dataset.previewTitle = p.title; b.dataset.busy = String(active || growthBusy); b.disabled ||= !!$('#improvement-title').value && $('#improvement-title').value !== p.title; }
      card.append(b);
    };
    if (p.status === 'AWAITING_APPROVAL' && !p.stale) { action(report.simulated ? 'Approve exact preview and simulate publish' : 'Approve exact preview and publish to production', 'publish'); action('Decline', 'decline'); }
    if (['INTENT', 'UNKNOWN', 'PUBLISHED', 'VERIFIED'].includes(p.status)) action('Verify public release and audit (read-only)', 'verify');
    return card;
  }));
}
async function improvementAction(action, body) {
  if (growthBusy) return; growthBusy = true; const id = selected;
  try { notice(action === 'publish' ? 'Publishing the exact approved title…' : 'Updating improvement evidence…'); const report = await api(`/runs/${id}/grow/improvements/${action}`, body); if (selected === id) renderImprovements(report); notice('Improvement state saved. Review the publication and verification status.'); }
  finally { growthBusy = false; await refresh(); }
}
$('#improvement-form').onsubmit = event => { event.preventDefault(); improvementAction('prepare', { title: $('#improvement-title').value }).catch(e => notice(e.message)); };
$('#improvement-title').oninput = () => { for (const b of document.querySelectorAll('[data-preview-title]')) b.disabled = b.dataset.busy === 'true' || $('#improvement-title').value !== b.dataset.previewTitle; };
$('#download-improvements').onclick = () => download(`/runs/${selected}/grow/improvements`, 'launchkit-improvements.json');
async function refreshCloud() {
  if (!selected || cloudRefreshing) return;
  cloudRefreshing = true; const id = selected;
  try {
    const report = await api(`/runs/${id}/cloud`); if (id !== selected) return;
    cloudReportRun = id; const state = report.cloud;
    $('#cloud-target').textContent = `${report.domain} · alerts to ${report.recipient || 'No verified inbox selected'}`;
    $('#cloud-status').textContent = report.error || (state ? `${state.settings.enabled ? 'Enabled' : 'Disabled'} · ${state.stale || state.scheduleMissing ? 'AWAITING / MISSING OBSERVATIONS' : state.last?.status || 'UNKNOWN'} · last cloud check ${time(state.last?.finishedAt)}` : report.status.replaceAll('_', ' '));
    $('#cloud-verification').textContent = state ? `Scheduled check: ${state.verification.scheduledCheck ? 'observed' : 'not yet observed'}. Notification drill delivery: ${state.verification.notificationVerified ? 'confirmed' : 'not yet confirmed'}. ${state.verification.operational && !report.releasePending ? 'Cloud monitoring verified and current.' : 'Continuous coverage is not yet verified.'}` : 'Deploy first, then verify a real scheduled check and email delivery. Cron changes can take time to propagate.';
    $('#cloud-evidence').textContent = JSON.stringify(report, null, 2);
    $('#cloud-release').textContent = report.releasePending ? 'Cloud monitor still expects an earlier release. Retry release sync; older monitors must first be updated using Deploy / update cloud monitor.' : '';
    $('#sync-cloud-release').hidden = !report.releasePending;
    if (report.releasePending) $('#cloud-verification').textContent += ' Release reconciliation is pending; current release coverage is not yet verified.';
    if (cloudFormRun !== id) { $('[name=cloudEnabled]').checked = state?.settings.enabled || false; $('[name=cloudInterval]').value = state?.settings.intervalMinutes || 5; $('[name=cloudNotifications]').checked = state?.settings.notifications || false; $('[name=cloudAuthorized]').checked = false; cloudFormRun = id; }
    $('#cloud-incidents').replaceChildren(...(state?.incidents || []).filter(i => !i.resolvedAt).map(incident => {
      const div = document.createElement('article'); div.className = 'incident'; const p = document.createElement('p'); p.textContent = `${incident.severity}: ${incident.check} · ${incident.message}`; div.append(p);
      if (!incident.acknowledgedAt) div.append(button('Acknowledge cloud alert', async () => { await api(`/runs/${id}/cloud/acknowledge`, { incidentId: incident.id }); await refreshCloud(); })); return div;
    }));
  } catch (e) { if (id === selected) $('#cloud-status').textContent = `Cloud status unavailable: ${e.message}`; }
  finally { cloudRefreshing = false; }
}
$('#refresh-cloud').onclick = () => refreshCloud();
$('#sync-cloud-release').onclick = async () => { try { await api(`/runs/${selected}/cloud/release`, {}); await refreshCloud(); } catch (e) { notice(e.message); } };
$('#cloud-form').onsubmit = async event => { event.preventDefault(); try { await api(`/runs/${selected}/cloud/deploy`, cloudInput()); notice('Cloud deployment started. Refresh cloud status after the operator finishes; scheduled evidence arrives separately.'); await refresh(); } catch (e) { notice(e.message); } };
$('#save-cloud').onclick = async () => { try { await api(`/runs/${selected}/cloud/configure`, cloudInput()); cloudFormRun = undefined; await refreshCloud(); } catch (e) { notice(e.message); } };
$('#disable-cloud').onclick = async () => { try { await api(`/runs/${selected}/cloud/configure`, { enabled: false, intervalMinutes: Number($('[name=cloudInterval]').value), notifications: false }); cloudFormRun = undefined; await refreshCloud(); } catch (e) { notice(e.message); } };
$('#verify-cloud').onclick = async () => { try { await api(`/runs/${selected}/cloud/verification`, {}); notice('Verification drill armed for two real scheduled checks. Confirm receipt from both emails.'); await refreshCloud(); } catch (e) { notice(e.message); } };
setInterval(() => { if (selected && !$('#cloud-operate').hidden) void refreshCloud(); }, 60_000);
const time = value => value ? new Date(value).toLocaleString() : 'Never';
function item(text) { const li = document.createElement('li'); li.textContent = text; return li; }
function renderOperations(report, active) {
  $('#operate').hidden = false;
  const last = report.last;
  $('#health-status').textContent = `${report.mode === 'mock' ? 'SIMULATION · ' : ''}${report.stale ? 'STALE / NOT CHECKED' : last.status} · monitoring ${report.settings.enabled ? 'enabled' : 'paused'}${active ? ' · operator busy' : ''}`;
  $('#health-status').dataset.health = report.stale ? 'UNKNOWN' : last.status;
  $('#health-timing').textContent = `Last check: ${time(last?.finishedAt)}. ${report.settings.enabled ? `Next due: ${time(report.nextCheckAt)} (when the operator is free).` : 'Monitoring is paused.'}${report.eligible ? ' Manual checks are available without relaunching.' : ' This entry is a draft. Select the existing deployed business in Saved businesses, or launch this draft only if it is a new business.'}${active ? ' Actions are disabled while the current operation finishes.' : ''}`;
  if (operationsFormRun !== report.runId) {
    $('[name=monitoring]').checked = report.settings.enabled;
    $('[name=intervalMinutes]').value = report.settings.intervalMinutes;
    $('[name=usageEnabled]').checked = report.settings.usageEnabled;
    operationsFormRun = report.runId;
  }
  for (const id of ['check-health', 'recover']) $(`#${id}`).disabled = active || !report.eligible;
  $('#save-operations').disabled = active;
  $('#health-checks').replaceChildren(...(last?.checks || []).map(check => {
    const li = item(`${check.name}: ${check.status} · ${check.message}`); li.dataset.status = check.status; return li;
  }));
  const incidents = [...report.incidents].reverse().sort((a, b) => Number(!!a.resolvedAt) - Number(!!b.resolvedAt));
  $('#incidents').replaceChildren(...(incidents.length ? incidents.map(incident => {
    const div = document.createElement('article'); div.className = `incident ${incident.resolvedAt ? 'resolved' : ''}`;
    const title = document.createElement('strong'); title.textContent = `${incident.resolvedAt ? 'RESOLVED' : incident.severity} · ${incident.check} · ${incident.message}`;
    const p = document.createElement('p'); p.textContent = incident.guidance;
    const dates = document.createElement('p'); dates.className = 'hint'; dates.textContent = `First observed ${time(incident.openedAt)} · last observed ${time(incident.lastSeenAt)} · ${incident.occurrences} observations${incident.resolvedAt ? ` · recovered ${time(incident.resolvedAt)}` : ''}${incident.acknowledgedAt ? ` · acknowledged ${time(incident.acknowledgedAt)}` : ''}`;
    div.append(title, p, dates);
    if (!incident.resolvedAt && !incident.acknowledgedAt) {
      const acknowledge = button('Acknowledge alert', async () => { await api(`/runs/${report.runId}/operate/acknowledge`, { incidentId: incident.id }); await refresh(); });
      acknowledge.disabled = active; div.append(acknowledge);
    }
    return div;
  }) : [item('No incidents recorded. Unchecked periods are not evidence of healthy service.')]));
  const usage = report.usage;
  $('#usage-summary').textContent = usage?.status === 'AVAILABLE' ? `${usage.simulated ? 'Simulated: ' : ''}${usage.requests.toLocaleString()} requests · ${usage.errors.toLocaleString()} errors. ${usage.message}` : usage?.message || (report.settings.usageEnabled ? 'Usage will be read at the next health check.' : 'Usage collection is disabled.');
  $('#usage-timing').textContent = usage ? `Status: ${usage.status} · fetched ${time(usage.checkedAt)} · window ${time(usage.from)} to ${time(usage.to)}` : '';
  $('#cost-summary').textContent = report.costs.message;
  $('#recorded-costs').replaceChildren(...(report.costs.recorded.length ? report.costs.recorded.map(cost => item(`${report.mode === 'mock' ? 'Simulated · ' : ''}${cost.type}: ${cost.amount} ${cost.currency}${cost.renewal ? ` · quoted renewal ${cost.renewal} ${cost.currency}` : ''}. ${cost.evidence || ''}`)) : [item('No launch costs recorded. Provider billing total is unavailable.') ]));
  $('#health-history').replaceChildren(...report.history.slice(-20).reverse().map(check => item(`${time(check.finishedAt)} · ${check.simulated ? 'SIMULATION · ' : ''}${check.status}`)));
  $('#operation-events').replaceChildren(...report.events.slice(-30).reverse().map(event => item(`${time(event.at)} · ${event.kind} · ${event.message}`)));
}
$('#operate-form').onsubmit = async event => { event.preventDefault(); const id = selected; try {
  await api(`/runs/${id}/operate`, { enabled: $('[name=monitoring]').checked, intervalMinutes: Number($('[name=intervalMinutes]').value), usageEnabled: $('[name=usageEnabled]').checked });
  operationsFormRun = undefined; notice('Monitoring settings saved. Enabled checks run within 30 seconds when the operator is free.'); await refresh();
} catch (e) { notice(e.message); } };
$('#check-health').onclick = async () => { try { await api(`/runs/${selected}/operate/check`, {}); notice('Read-only health check started.'); await refresh(); } catch (e) { notice(e.message); } };
$('#recover').onclick = async () => { try { await api(`/runs/${selected}/operate/recover`, {}); notice('Launch inspection started. Review any required approvals in launch progress.'); await refresh(); } catch (e) { notice(e.message); } };
async function download(path, filename) {
  try { const report = await api(path); const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url); } catch (e) { notice(e.message); }
}
$('#download-operations').onclick = () => download(`/runs/${selected}/operate`, 'launchkit-operations.json');
$('#launch-form').onsubmit = async event => { event.preventDefault(); try {
  const data = new FormData(event.target);
  const result = await api('/runs', { appPath: data.get('appPath'), domain: data.get('domain'), mode: data.get('mode'), accountId: data.get('accountId'), inbox: data.get('inbox'), outbound: data.has('outbound'), www: data.has('www'), seo: { approved: data.has('seo'), title: data.get('title'), description: data.get('description') }, analytics: { approved: false, publicPaths: ['/'] } });
  selected = result.id; notice('Launch started. You can close this window and resume later.'); await refresh();
} catch (e) { notice(e.message); } };
async function accounts() { const items = await api('/accounts'); $('#accounts').replaceChildren(...items.map(item => { const option = document.createElement('option'); option.value = item.id; option.label = item.name; return option; })); if (items.length === 1 && !$('[name=accountId]').value) $('[name=accountId]').value = items[0].id; }
$('#connections-form').onsubmit = async event => { event.preventDefault(); try { await api('/connections', Object.fromEntries(new FormData(event.target))); event.target.reset(); await accounts(); notice('Connections saved. Continue with Growth or Operate for an existing production business; no relaunch is needed.'); await refresh(); } catch (e) { notice(e.message); } };
$('#configure-analytics').onclick = async () => { try { notice('Configuring and checking Cloudflare Web Analytics...'); const step = await api(`/runs/${selected}/analytics`, {}); notice(step.message || step.evidence?.message || step.status); await refresh(); } catch (e) { notice(e.message); } };
$('#resume').onclick = async () => { try { selected = (await api(`/runs/${selected}/resume`, {})).id; await refresh(); } catch (e) { notice(e.message); } };
$('#download').onclick = () => download(`/runs/${selected}/report`, 'launchkit-report.json');
function fill(defaults) {
  for (const name of ['appPath', 'domain', 'inbox', 'accountId', 'mode']) if (defaults[name] !== undefined) $(`[name=${name}]`).value = defaults[name];
  for (const name of ['www', 'outbound']) if (defaults[name] !== undefined) $(`[name=${name}]`).checked = defaults[name];
  if (defaults.seo) { $('[name=seo]').checked = defaults.seo.approved; $('[name=title]').value = defaults.seo.title || ''; $('[name=description]').value = defaults.seo.description || ''; }
}
api('/apps').then(apps => { for (const app of apps) { const option = document.createElement('option'); option.value = app.path; option.label = app.name; $('#apps').append(option); } if (apps.length === 1 && !$('[name=appPath]').value) $('[name=appPath]').value = apps[0].path; }).catch(e => notice(e.message));
accounts().catch(e => notice(e.message));
async function initialize() {
  await refresh();
  if (!selected) { const defaults = await api('/defaults'); if (!selected) fill(defaults); }
}
initialize().catch(e => notice(e.message)); setInterval(() => refresh().catch(e => notice(e.message)), 2000);
