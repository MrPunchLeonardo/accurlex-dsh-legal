'use strict';

// Based on the released accurLex SMS client (2026-10-19).
// DSH adds cancellation and an explicit challenge binding; see README.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const BASE = 'https://accurlex.com/index.php/SkillHub/';
const CONSENT = 'skillhub-2026-10-19';
const ERRORS = {
  invalid_arguments: '参数无效，请核对 action、capability 和对应字段。', consent_required: '请先向用户说明协议、手机号用途、权限和费用，并取得同意。',
  api_key_required: '尚未开通，请按 Skill 的短信开通流程继续。', credential_invalid: '指定的凭证无效，请核对；不会自动换用其他账号。',
  credential_exists: '本地已有此功能的凭证；如需替换，请先取得用户同意并使用 --replace。',
  local_storage_failed: '无法安全保存本地凭证；请检查当前用户目录及权限。', request_in_progress: '当前开通正在处理，请稍后使用同一流程继续。',
  request_failed: '请求中断或结果不明，已保留本次开通状态。请使用相同命令恢复，不要反复发送短信。',
  response_invalid: '开通响应不完整，已保留本次状态，请稍后恢复。', flow_conflict: '当前开通对应另一个手机号或功能，请先完成原流程。',
  flow_expired: '开通流程已过期，请重新发起。', flow_superseded: '已有更新的验证码流程，请使用最新流程。',
  code_expired: '验证码已过期，请重新发起开通。', code_invalid: '验证码错误，请用户核对后重新输入。',
  rate_limited: '操作次数或频率达到限制，请稍后重试，不要连续发码。', sms_unavailable: '短信服务暂不可用，请稍后重新开通。',
  service_unavailable: '服务暂不可用，已保留开通状态，请稍后恢复。', account_unavailable: '账号当前无法开通，请到 accurLex 网站核对账号状态。',
  key_unavailable: '本次凭证已停用，请到 accurLex 网站核对。', key_limit: '账号已达到10个启用密钥的上限，请在控制台停用不用的密钥后继续。'
};
class OnboardingError extends Error { constructor(code) { super(ERRORS[code] || ERRORS.request_failed); this.code = code in ERRORS ? code : 'request_failed'; } }
const fail = code => { throw new OnboardingError(code); };
const validKey = key => typeof key === 'string' && /^ak_live_[A-Za-z0-9_-]{32,128}$/.test(key);
function scopeFor(skill, mode = '') {
  if (skill === 'accurlex-legal-qa' && ['deep', 'expert'].includes(mode)) return 'qa_' + mode;
  const scopes = { 'accurlex-law-search': 'law_search', 'accurlex-draft': 'document_draft', 'accurlex-contract-review-v2': 'contract_review' };
  if (scopes[skill] && mode === '') return scopes[skill];
  fail('invalid_arguments');
}
function config() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'skill.json'), 'utf8')); }
  catch { fail('invalid_arguments'); }
}
function locations(scope, home = os.homedir()) {
  if (!['qa_deep','qa_expert','law_search','document_draft','contract_review'].includes(scope)) fail('invalid_arguments');
  const dir = path.join(home, '.accurlex', 'skillhub');
  return { dir, key: path.join(dir, scope + '.env'), state: path.join(dir, '.pending-' + scope + '.json'), lock: path.join(dir, '.lock-' + scope) };
}
function noLink(file) {
  try { if (fs.lstatSync(file).isSymbolicLink()) fail('local_storage_failed'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function protect(file, directory) {
  if (process.platform === 'win32') {
    const identity = spawnSync('whoami.exe', ['/user','/fo','csv','/nh'], {encoding:'utf8',windowsHide:true});
    const sid = identity.stdout?.match(/S-1-[0-9-]+/)?.[0];
    if (identity.status !== 0 || !sid) fail('local_storage_failed');
    const script = "$ErrorActionPreference='Stop'; $acl=New-Object System.Security.AccessControl." + (directory?'DirectorySecurity':'FileSecurity') +
      "; $acl.SetAccessRuleProtection($true,$false); $sid=New-Object System.Security.Principal.SecurityIdentifier('"+sid+"'); $acl.SetOwner($sid); " +
      "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','"+(directory?'ContainerInherit,ObjectInherit':'None')+"','None','Allow'); $acl.AddAccessRule($rule); [System.IO."+(directory?'Directory':'File')+"]::SetAccessControl('"+file.replace(/'/g,"''")+"',$acl)";
    const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], {encoding:'utf8',windowsHide:true});
    if (result.status !== 0) fail('local_storage_failed');
  } else fs.chmodSync(file, directory ? 0o700 : 0o600);
}
function secureDirectory(dir) {
  for (const entry of [path.dirname(dir),dir]) {
    noLink(entry); fs.mkdirSync(entry,{recursive:true,mode:0o700}); protect(entry,true);
  }
}
function atomicWrite(file, value) {
  noLink(file);
  const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    const fd=fs.openSync(temp,'wx',0o600);
    try {protect(temp,false);fs.writeFileSync(fd,value);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.renameSync(temp,file);
  } finally { try { fs.unlinkSync(temp); } catch(error) { if(error.code!=='ENOENT') throw error; } }
}
function readState(file) {
  noLink(file);
  try { return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch(error) { if(error.code==='ENOENT') return null; fail('local_storage_failed'); }
}
function readKeyFile(file) {
  noLink(file);
  try { return fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').match(/^\s*ACCURLEX_API_KEY\s*=\s*(.*?)\s*$/m)?.[1]?.replace(/^(['"])(.*)\1$/,'$2') || ''; }
  catch(error) { if(error.code==='ENOENT') return null; fail('credential_invalid'); }
}
function resolveKey(scope, opts = {}, env = process.env, home = os.homedir()) {
  let key;
  if (opts.envFile) {
    key = readKeyFile(opts.envFile);
    if (!key || !validKey(key.trim())) fail('credential_invalid');
  } else if (env.ACCURLEX_API_KEY !== undefined) {
    key = env.ACCURLEX_API_KEY;
    if (!validKey(key.trim())) fail('credential_invalid');
  } else {
    key = readKeyFile(locations(scope,home).key);
    if (key === null) fail('api_key_required');
    if (!validKey(key.trim())) fail('credential_invalid');
  }
  return key.trim();
}
async function post(action, payload, fetchImpl, signal) {
  const controller = new AbortController(); const timer = setTimeout(()=>controller.abort(),25000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once:true});
  if (signal?.aborted) abort();
  try {
    const response = await fetchImpl(BASE+action,{method:'POST',redirect:'error',signal:controller.signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const reader = response.body?.getReader(); if(!reader)fail('response_invalid');
    let length=0;const chunks=[];
    try { while(true) {const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>16384)fail('response_invalid');chunks.push(value);} }
    finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    let data; try {data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('response_invalid');}
    if(!data || typeof data!=='object' || Array.isArray(data))fail('response_invalid');
    if(!response.ok || data.error) fail(data.error in ERRORS ? data.error : 'service_unavailable');
    return data;
  } catch(error) {if(error instanceof OnboardingError)throw error;fail('request_failed');}
  finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
function argsFor(args) {
  const options = {action:args[0]};
  for(let i=1;i<args.length;i++) {
    if(['--consent','--replace','--restart'].includes(args[i])) options[args[i].slice(2)]=true;
    else if(['--mode','--env'].includes(args[i]) && args[i+1] && !args[i+1].startsWith('--')) options[args[i]==='--mode'?'mode':'envFile']=args[++i];
    else fail('invalid_arguments');
  }
  if(!['check','start','complete','--help'].includes(options.action))fail('invalid_arguments');
  return options;
}
async function run(args, input = {}, dependencies = {}) {
  const options=argsFor(args); if(options.action==='--help') return {usage:'node scripts/onboarding.cjs check|start|complete [--mode deep|expert] [--consent] [--replace] [--restart] [--env path]; start 标准输入 JSON {"phone":"手机号"}，complete 标准输入 JSON {"code":"验证码"}。不要把秘密放进命令行参数。--restart 仅在用户同意重新发短信且距上次至少60秒时使用。'};
  const cfg=dependencies.config||config(); const mode=options.mode ?? cfg.fixedMode ?? (cfg.skill==='accurlex-legal-qa'?'deep':'');
  if(cfg.fixedMode !== undefined && mode !== cfg.fixedMode)fail('invalid_arguments');
  const scope=scopeFor(cfg.skill,mode); const home=dependencies.home||os.homedir(); const env=dependencies.env||process.env;
  if(options.action==='check') {
    try {resolveKey(scope,options,env,home);return {status:'ready',scope};}
    catch(error) {if(error.code==='api_key_required')return {status:'needs_onboarding',scope};throw error;}
  }
  if(!input || typeof input!=='object' || Array.isArray(input))fail('invalid_arguments');
  if(options.action==='start' && !options.consent)fail('consent_required');
  const where=locations(scope,home);
  secureDirectory(where.dir);noLink(where.lock);
  let lock;
  try {lock=fs.openSync(where.lock,'wx',0o600);} catch(error) {if(error.code==='EEXIST')fail('request_in_progress');fail('local_storage_failed');}
  try {
    fs.writeFileSync(lock,JSON.stringify({pid:process.pid,createdAt:Date.now()}));
    if(options.action==='start') {
      if(Object.keys(input).some(k=>k!=='phone') || typeof input.phone!=='string'||!/^1[3-9][0-9]{9}$/.test(input.phone))fail('invalid_arguments');
      if(!options.replace && (options.envFile || env.ACCURLEX_API_KEY !== undefined || fs.existsSync(where.key)))fail('credential_exists');
      let state=readState(where.state);
      if(options.restart && state && Date.now()-state.createdAt<60000)fail('rate_limited');
      if(state && !options.restart && Date.now()-state.createdAt<600000) {
        if(state.phone!==input.phone||state.skill!==cfg.skill||state.scope!==scope)fail('flow_conflict');
      } else state={phone:input.phone,skill:cfg.skill,scope,mode,clientSecret:crypto.randomBytes(32).toString('hex'),createdAt:Date.now(),
        baseKeyHash:fs.existsSync(where.key)?crypto.createHash('sha256').update(readKeyFile(where.key)||'').digest('hex'):null};
      atomicWrite(where.state,JSON.stringify(state));
      const reply=await post('start',{phone:state.phone,skill:state.skill,mode:state.mode,client_secret:state.clientSecret,consent_version:CONSENT},dependencies.fetch||fetch,dependencies.signal);
      if(reply.status!=='sms_sent'||reply.scope!==scope||!/^([a-f0-9]{32})$/.test(reply.challenge_id))fail('response_invalid');
      state.challengeId=reply.challenge_id;atomicWrite(where.state,JSON.stringify(state));
      return {status:'sms_sent',scope,connection_id:reply.challenge_id,message:'验证码已发送，请用户提供手机收到的验证码。',expiresAt:reply.expires_at};
    }
    if(Object.keys(input).some(k=>k!=='code')||typeof input.code!=='string'||!/^\d{4}$/.test(input.code))fail('invalid_arguments');
    const state=readState(where.state);
    if(!state || Date.now()-state.createdAt>=600000)fail('flow_expired');
    if(!state.challengeId)fail('request_failed');
    if(dependencies.expectedChallengeId !== undefined && state.challengeId !== dependencies.expectedChallengeId)fail('flow_conflict');
    if(state.skill!==cfg.skill||state.scope!==scope)fail('flow_conflict');
    const reply=await post('complete',{challenge_id:state.challengeId,client_secret:state.clientSecret,code:input.code},dependencies.fetch||fetch,dependencies.signal);
    if(reply.status!=='ready'||reply.scope!==scope||!validKey(reply.api_key))fail('response_invalid');
    const current=readKeyFile(where.key);
    const currentHash=current===null?null:crypto.createHash('sha256').update(current).digest('hex');
    if(currentHash!==state.baseKeyHash && current!==reply.api_key)fail('credential_exists');
    atomicWrite(where.key,'ACCURLEX_API_KEY='+reply.api_key+'\n');
    fs.unlinkSync(where.state);
    return {status:'ready',scope,message:'开通完成，凭证已保存到本机，请继续原任务。'};
  } finally {fs.closeSync(lock);fs.unlinkSync(where.lock);}
}
if(require.main===module) {
  (async()=>{
    const args=process.argv.slice(2);let input={};
    if(['start','complete'].includes(args[0])) {
      const chunks=[];let length=0;
      for await(const chunk of process.stdin){length+=chunk.length;if(length>4096)fail('invalid_arguments');chunks.push(chunk);}
      try{input=JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,''));}catch{fail('invalid_arguments');}
    }
    process.stdout.write(JSON.stringify(await run(args,input))+'\n');
  })().catch(error=>{const code=error instanceof OnboardingError?error.code:'local_storage_failed';process.stderr.write(JSON.stringify({error:code,message:ERRORS[code]})+'\n');process.exitCode=1;});
}
module.exports={run,resolveKey,scopeFor,locations,OnboardingError,CONSENT};
