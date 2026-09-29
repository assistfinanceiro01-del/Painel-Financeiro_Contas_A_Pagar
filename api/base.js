// Base compartilhada do painel (Vercel Blob).
// GET  /api/base                          -> devolve a base completa
// POST /api/base {acao:'importar',rows,info}  -> junta os lançamentos (substitui só as datas que vieram na planilha)
// POST /api/base {acao:'londrino',londrino}   -> salva os valores do Londrino
// POST /api/base {acao:'substituir',dados,londrino,info} -> grava a base inteira (usado só quando o servidor está vazio)
import { put, list, del } from '@vercel/blob';

const PREFIX = 'painel-cp/base';
const VERSOES = 15; // versões anteriores guardadas como backup automático

async function blobsOrdenados() {
  const { blobs } = await list({ prefix: PREFIX, limit: 1000 });
  return blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

async function ler() {
  const blobs = await blobsOrdenados();
  if (!blobs.length) return { dados: [], londrino: {}, info: null, historico: [] };
  const r = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('falha ao ler a base (' + r.status + ')');
  return r.json();
}

async function gravar(doc) {
  doc.atualizadoEm = new Date().toISOString();
  await put(PREFIX + '.json', JSON.stringify(doc), {
    access: 'public',
    addRandomSuffix: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60,
  });
  const velhos = (await blobsOrdenados()).slice(VERSOES).map(b => b.url);
  if (velhos.length) await del(velhos);
  return doc;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json(await ler());
    if (req.method !== 'POST') return res.status(405).json({ erro: 'método não permitido' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const doc = await ler();
    doc.historico = doc.historico || [];

    if (body.acao === 'importar') {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return res.status(400).json({ erro: 'nenhum lançamento enviado' });
      const datas = [...new Set(rows.map(r => r.prog).filter(Boolean))];
      const mantidos = (doc.dados || []).filter(r => !datas.includes(r.prog));
      const substituidos = (doc.dados || []).length - mantidos.length;
      doc.dados = mantidos.concat(rows);
      doc.info = body.info || doc.info;
      doc.historico.unshift({ arquivo: (body.info || {}).fonte || '', quando: new Date().toISOString(), linhas: rows.length, substituidos, datas: datas.sort() });
      doc.historico = doc.historico.slice(0, 200);
      await gravar(doc);
      return res.status(200).json({ ok: true, total: doc.dados.length, substituidos, atualizadoEm: doc.atualizadoEm });
    }
    if (body.acao === 'londrino') {
      doc.londrino = Object.assign({}, doc.londrino || {}, body.londrino || {});
      await gravar(doc);
      return res.status(200).json({ ok: true, atualizadoEm: doc.atualizadoEm });
    }
    if (body.acao === 'substituir') {
      if ((doc.dados || []).length) return res.status(409).json({ erro: 'o servidor já tem uma base; não foi substituída' });
      doc.dados = Array.isArray(body.dados) ? body.dados : [];
      doc.londrino = body.londrino || {};
      doc.info = body.info || null;
      doc.historico.unshift({ arquivo: 'base inicial enviada do navegador', quando: new Date().toISOString(), linhas: doc.dados.length });
      await gravar(doc);
      return res.status(200).json({ ok: true, total: doc.dados.length, atualizadoEm: doc.atualizadoEm });
    }
    return res.status(400).json({ erro: 'ação inválida' });
  } catch (e) {
    const semBlob = /BLOB_READ_WRITE_TOKEN|No token found/i.test(String(e && e.message));
    return res.status(500).json({ erro: semBlob ? 'armazenamento Blob não conectado ao projeto na Vercel' : String(e && e.message || e) });
  }
}
