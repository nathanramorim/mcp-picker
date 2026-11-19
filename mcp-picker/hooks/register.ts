import type { Register } from 'claude-code';

// null = session.start ainda não decidiu; Set = decisão tomada
let allowedServers: Set<string> | null = null;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const register: Register = (on) => {
  // Intercepta cada tentativa do engine de conectar um servidor MCP.
  // Se allowedServers ainda é null (session.start não completou),
  // segura o servidor. Depois da seleção, apenas os escolhidos passam.
  on('mcp.connect', async ($, e, next) => {
    if (allowedServers === null) {
      // session.start ainda não decidiu — segura (held)
      return { value: { isConnected: false as const, reason: 'failed' as const, message: 'mcp-picker: aguardando seleção' } };
    }
    if (allowedServers.has('*') || allowedServers.has(e.server)) return next(e);
    // servidor não selecionado — recusa
    return { value: { isConnected: false as const, reason: 'disabled' as const, message: `mcp-picker: "${e.server}" não selecionado nesta sessão` } };
  });

  on('session.start', async ($, e, next) => {
    // Sessões não-interativas (SDK, -p): ativa tudo
    if (!e.isInteractive) {
      allowedServers = new Set(['*']);
      return next(e);
    }

    // Localiza ~/.claude a partir do caminho do transcript
    let claudeDir = '';
    try {
      const info = await ($ as any).session.info() as { transcriptPath?: string };
      const m = info.transcriptPath?.match(/^(.+?)\/projects\//);
      if (m?.[1]) claudeDir = m[1];
    } catch { /* ignora */ }

    // Lê todos os servidores configurados nas settings
    const seen = new Set<string>();
    const settingsPaths = [
      `${claudeDir}/settings.json`,
      `${e.cwd}/.claude/settings.json`,
      `${e.cwd}/.claude/settings.local.json`,
    ].filter(Boolean);

    for (const p of settingsPaths) {
      try {
        const text = await ($ as any).fs.read(p) as string;
        const json = JSON.parse(text);
        if (json?.mcpServers && typeof json.mcpServers === 'object') {
          for (const k of Object.keys(json.mcpServers)) seen.add(k);
        }
      } catch { /* arquivo ausente ou inválido */ }
    }

    const servers = [...seen].sort();

    if (servers.length === 0) {
      allowedServers = new Set(['*']);
      return next(e);
    }

    // Carrega seleção anterior
    const prevRaw = await ($ as any).store.get('mcp-picker:v1') as string[] | null;
    const prevSet = new Set(prevRaw ?? servers);
    const hasRecent = prevRaw !== null && prevRaw.length > 0;

    // Diálogo principal — máximo 4 opções
    const mainOptions = hasRecent
      ? ['Todos', 'Recentes', 'Nenhum', 'Escolher']
      : ['Todos', 'Nenhum', 'Escolher', 'Escolher'];

    let mode = 'Todos';
    try {
      mode = await ($ as any).ui.ask('Quais MCPs ativar nesta sessão?', {
        options: mainOptions.slice(0, 4),
        header: 'MCPs',
      }) as string;
    } catch { /* descartado → padrão: Todos */ }

    const selected = new Set<string>();

    if (mode === 'Todos') {
      servers.forEach(s => selected.add(s));
    } else if (mode === 'Recentes') {
      servers.filter(s => prevSet.has(s)).forEach(s => selected.add(s));
      if (selected.size === 0) servers.forEach(s => selected.add(s)); // fallback
    } else if (mode === 'Nenhum') {
      // selected permanece vazio
    } else {
      // Modo "Escolher": itera em lotes de 4
      const batches = chunkArray(servers, 4);
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i] ?? [];
        if (batch.length === 0) continue;
        try {
          if (batch.length === 1) {
            // Lote com 1 servidor: pergunta direta
            const name = batch[0] as string;
            const ans = await ($ as any).ui.ask(
              `Ativar "${name}"?`,
              { options: ['Sim', 'Não'], header: 'MCPs' }
            ) as string;
            if (ans === 'Sim') selected.add(name);
          } else {
            // Lote com 2-4 servidores: multi-seleção
            const ans = await ($ as any).ui.ask(
              `MCPs ${i + 1}/${batches.length} — marque os que quer ativar:`,
              { options: batch.slice(0, 4) as string[], header: 'MCPs', multiSelect: true }
            ) as string;
            ans.split(', ').forEach(s => {
              const name = s.trim();
              if (servers.includes(name)) selected.add(name);
            });
          }
        } catch { /* lote descartado — nenhum deste lote */ }
      }
    }

    allowedServers = selected;

    // Persiste seleção para a próxima sessão
    try {
      await ($ as any).store.set('mcp-picker:v1', [...selected]);
    } catch { /* ignora */ }

    // Conecta os servidores escolhidos (libera os que estavam segurados)
    for (const server of selected) {
      ($ as any).mcp.connect(server).catch(() => {});
    }

    ($ as any).ui.toast(`${selected.size} de ${servers.length} MCPs ativos`);
    return next(e);
  });
};
