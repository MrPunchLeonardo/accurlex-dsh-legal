import os from 'node:os';
import onboarding from './onboarding-client.cjs';

export const CAPABILITIES = Object.freeze({
  qa_deep: { skill: 'accurlex-legal-qa', fixedMode: 'deep', label: '免费法律问答' },
  qa_expert: { skill: 'accurlex-legal-qa', fixedMode: 'expert', label: '专家法律问答' },
  law_search: { skill: 'accurlex-law-search', label: '法律法规检索（包含 deep/expert）' },
  document_draft: { skill: 'accurlex-draft', label: '法律文书起草' },
  contract_review: { skill: 'accurlex-contract-review-v2', label: '合同审查' },
});
export const SCOPES = Object.freeze(Object.keys(CAPABILITIES));

export function connectionGuidance(scope) {
  return `请用 accurlex_connect(action="status", capability="${scope}") 检查连接；如缺少凭证，先告知用户：手机号用于识别或创建 accurLex 账户，验证码由用户手机接收并在本对话中提供，本次只开通${CAPABILITIES[scope].label}权限，Key 私密保存在当前系统用户目录。用户协议 https://accurlex.com/user_agreement.html ，隐私政策 https://accurlex.com/privacy_policy.html ，价格与限额 https://accurlex.com/open-platform/pricing.html 。基础问答免费；其他功能或专家模式按服务端当前规则可能扣点，不自动充值。取得用户明确同意后，用 start 提交用户提供的手机号；收到 sms_sent 后询问4位验证码，再用同一 capability、connection_id 和验证码调用 complete；返回 ready 后继续原任务。不要自行接收、猜测验证码，不要让用户手动创建或复制 Key。`;
}

export function createConnection(dependencies = {}) {
  const env = () => dependencies.environment ?? process.env;
  const home = () => dependencies.home ?? os.homedir();
  const safe = async (operation) => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof onboarding.OnboardingError) throw error;
      throw new onboarding.OnboardingError('local_storage_failed');
    }
  };
  return {
    key(scope) {
      try { return onboarding.resolveKey(scope, {}, env(), home()); }
      catch (error) {
        if (error instanceof onboarding.OnboardingError) throw error;
        throw new onboarding.OnboardingError('local_storage_failed');
      }
    },
    environment: env,
    fetch: (...args) => (dependencies.fetchImpl ?? globalThis.fetch)(...args),
    run(args, signal) {
      return safe(async () => {
        if (!args || !Object.hasOwn(CAPABILITIES, args.capability)) throw new onboarding.OnboardingError('invalid_arguments');
        const allowed = {
          status: ['action', 'capability'],
          start: ['action', 'capability', 'phone', 'consent', 'replace', 'restart'],
          complete: ['action', 'capability', 'code', 'connection_id'],
        };
        if (!Object.hasOwn(allowed, args.action) || Object.keys(args).some(key => !allowed[args.action].includes(key))) {
          throw new onboarding.OnboardingError('invalid_arguments');
        }
        for (const flag of ['consent', 'replace', 'restart']) {
          if (args[flag] !== undefined && typeof args[flag] !== 'boolean') throw new onboarding.OnboardingError('invalid_arguments');
        }
        if (signal?.aborted) throw new onboarding.OnboardingError('request_failed');
        if (args.action === 'start' && env().ACCURLEX_API_KEY !== undefined) {
          // A new local key would be shadowed by this explicitly configured account.
          throw new onboarding.OnboardingError('credential_exists');
        }
        if (args.action === 'complete' && !/^[a-f0-9]{32}$/.test(args.connection_id ?? '')) {
          throw new onboarding.OnboardingError('invalid_arguments');
        }
        const command = [args.action === 'status' ? 'check' : args.action];
        for (const flag of ['consent', 'replace', 'restart']) if (args[flag] === true) command.push('--' + flag);
        const input = args.action === 'start' ? { phone: args.phone } : args.action === 'complete' ? { code: args.code } : {};
        return onboarding.run(command, input, {
          config: CAPABILITIES[args.capability], env: env(), home: home(),
          fetch: (...params) => (dependencies.fetchImpl ?? globalThis.fetch)(...params),
          signal, expectedChallengeId: args.connection_id,
        });
      });
    },
  };
}

export function createConnectionTool(connection) {
  return {
    name: 'accurlex_connect',
    description: '在 DeepSeek Harness 对话中连接 accurLex，无需用户打开网页创建 API Key。先 status 查看当前功能的本机凭证；缺少时向用户展示协议、隐私、手机号用途、权限和费用并取得同意，再 start 发送短信。验证码只能由用户手机接收并提供，complete 自动保存 Key，随后直接继续原法律任务。只申请用户当前需要的 capability，不批量开通其他权限；状态不表示已经联网验证 Key。短信和账户开通不会自动重试。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action', 'capability'],
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'complete'] },
        capability: { type: 'string', enum: SCOPES, description: '当前需要的权限。qa_deep 免费问答；qa_expert 专家问答；law_search 检索两种模式；document_draft 起草；contract_review 审查。' },
        phone: { type: 'string', description: '仅 start：用户提供的可收短信的中国大陆手机号。不在回复中复述完整号码。' },
        consent: { type: 'boolean', description: '仅 start：先向用户展示 status 返回的开通说明，用户明确同意后才设为 true。' },
        code: { type: 'string', description: '仅 complete：用户手机收到并主动提供的4位验证码，不猜测、不枚举。' },
        connection_id: { type: 'string', description: '仅 complete：同一次 start 返回的 connection_id，防止串用另一开通流程。' },
        replace: { type: 'boolean', description: '仅 start：用户明确要求更换当前功能的本机账户凭证时才使用；不撤销服务端旧 Key。' },
        restart: { type: 'boolean', description: '仅 start：用户要求重新发码且距上次至少60秒时使用。断连应先恢复原流程，不能循环重发。' },
      },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, tool: { type: 'string' }, content: { type: 'string' }, status: { type: 'string' }, scope: { type: 'string' }, connection_id: { type: 'string' }, expiresAt: {}, error: {} }, required: ['ok', 'tool', 'content'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    presentCall(args) {
      const titles = { status: '检查 accurLex 连接', start: '发送 accurLex 验证码', complete: '验证短信并连接 accurLex' };
      return { card: 'generic', kind: args?.action === 'status' ? 'read' : 'fetch',
        title: Object.hasOwn(titles, args?.action ?? '') ? titles[args.action] : '连接 accurLex',
        rawInput: { capability: Object.hasOwn(CAPABILITIES, args?.capability ?? '') ? args.capability : '待选择' } };
    },
    async execute(args, exec) {
      try {
        const result = await connection.run(args, exec?.signal);
        let content = result.status === 'needs_onboarding' ? connectionGuidance(result.scope)
          : result.status === 'sms_sent' ? `验证码已发送，请用户提供手机收到的4位验证码；使用 capability="${result.scope}"、connection_id="${result.connection_id}" 调用 complete。`
            : `当前 ${result.scope} 凭证已就绪，请继续用户原来的任务。无需额外发起收费调用来验证 Key。`;
        return { ok: true, tool: 'accurlex_connect', status: result.status, scope: result.scope, content,
          ...(result.connection_id ? { connection_id: result.connection_id, expiresAt: result.expiresAt ?? null } : {}) };
      } catch (error) {
        return { ok: false, tool: 'accurlex_connect', content: error.message, error: { code: error.code } };
      }
    },
  };
}
