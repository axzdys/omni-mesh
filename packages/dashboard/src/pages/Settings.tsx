import { useState } from 'react';
import { KeyRound, Bell, ShieldCheck, Copy, Plus, Trash2, Send, FileDown, FolderOpen } from 'lucide-react';
import { endpoints } from '../lib/api';
import type { RegKey, NodeInfo } from '@omni/shared';
import { usePoll } from '../hooks/hooks';
import { PageHeader } from '../components/bits';
import { Card, CardHeader, Badge, Button, Input, Label, Select, Textarea, Spinner, EmptyState } from '../components/ui/ui';
import { Dialog } from '../components/ui/dialog';
import { useToast } from '../components/ui/toast';
import { fmtRelative } from '../lib/utils';

export function Settings() {
  const toast = useToast();
  // keys
  const { data: keys, reload: reloadKeys } = usePoll<RegKey[]>(() => endpoints.keys(), 15000);
  const { data: nodes } = usePoll<NodeInfo[]>(() => endpoints.nodes(), 30000);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // webhook
  const { data: hook } = usePoll<{ type: string; telegramChatId: string; genericUrl: string; hasBotToken: boolean; hasSecret: boolean }>(() => endpoints.webhookSettings(), 60000);
  const [hookType, setHookType] = useState('none');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [genericUrl, setGenericUrl] = useState('');
  const [genericSecret, setGenericSecret] = useState('');
  const [hookLoaded, setHookLoaded] = useState(false);
  const [testing, setTesting] = useState(false);
  if (hook && !hookLoaded) {
    setHookType(hook.type);
    setChatId(hook.telegramChatId);
    setGenericUrl(hook.genericUrl);
    setHookLoaded(true);
  }

  // password
  const [curPass, setCurPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newPass2, setNewPass2] = useState('');
  const [changing, setChanging] = useState(false);

  // files
  const [fileNode, setFileNode] = useState('');
  const [filePath, setFilePath] = useState('/etc/hostname');
  const [uploadPath, setUploadPath] = useState('/tmp/omni-upload.txt');
  const [fileBusy, setFileBusy] = useState(false);

  const createKey = async () => {
    setCreating(true);
    try {
      const res = await endpoints.createKey(newKeyName || 'unnamed');
      setCreatedKey(res.key);
      setNewKeyName('');
      reloadKeys();
    } catch (e) {
      toast(e instanceof Error ? e.message : '签发失败', 'error');
    } finally {
      setCreating(false);
    }
  };

  const revokeKey = async (id: string) => {
    try {
      await endpoints.revokeKey(id);
      toast('密钥已吊销', 'success');
      reloadKeys();
    } catch (e) {
      toast(e instanceof Error ? e.message : '吊销失败', 'error');
    }
  };

  const copyKey = async (k: string) => {
    await navigator.clipboard.writeText(k);
    toast('已复制到剪贴板', 'success');
  };

  const saveHook = async () => {
    try {
      await endpoints.saveWebhook({
        type: hookType,
        telegramBotToken: botToken || undefined,
        telegramChatId: chatId,
        genericUrl,
        genericSecret: genericSecret || undefined,
      });
      toast('Webhook 配置已保存（密钥已加密存储）', 'success');
      setBotToken('');
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'error');
    }
  };

  const testHook = async () => {
    setTesting(true);
    try {
      const res = await endpoints.testWebhook();
      toast(res.ok ? '测试消息已发送 ✓' : `发送失败: ${res.error}`, res.ok ? 'success' : 'error');
    } finally {
      setTesting(false);
    }
  };

  const changePassword = async () => {
    if (newPass !== newPass2) {
      toast('两次输入的新密码不一致', 'error');
      return;
    }
    setChanging(true);
    try {
      await endpoints.changePassword(curPass, newPass);
      toast('密码已更新', 'success');
      setCurPass('');
      setNewPass('');
      setNewPass2('');
    } catch (e) {
      toast(e instanceof Error ? e.message : '修改失败', 'error');
    } finally {
      setChanging(false);
    }
  };

  const testDownload = async () => {
    setFileBusy(true);
    try {
      await endpoints.downloadFile(fileNode, filePath);
      toast('文件已下载', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : '下载失败', 'error');
    } finally {
      setFileBusy(false);
    }
  };

  const testUpload = async (file: File) => {
    setFileBusy(true);
    try {
      const buf = await file.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = btoa(bin);
      await endpoints.uploadFile(fileNode, uploadPath.endsWith('.txt') ? uploadPath : uploadPath + '/' + file.name, b64);
      toast('文件已上传到节点', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : '上传失败', 'error');
    } finally {
      setFileBusy(false);
    }
  };

  const onlineNodes = (nodes ?? []).filter((n) => n.status === 'online');

  return (
    <div className="p-4 sm:p-6 max-w-[1000px] mx-auto space-y-5">
      <PageHeader title="系统设置" description="注册密钥、告警推送与安全配置" />

      {/* Registration keys */}
      <Card>
        <CardHeader title="节点注册密钥" subtitle="Agent 首次接入时使用，注册后自动换取专属节点令牌" icon={<KeyRound className="h-4 w-4 text-cyan-400" />} />
        <div className="p-4 space-y-3">
          <div className="flex gap-2">
            <Input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="密钥备注名（如 lab-server）" className="max-w-xs" />
            <Button variant="primary" size="md" loading={creating} onClick={createKey}>
              <Plus className="h-4 w-4" /> 签发新密钥
            </Button>
          </div>
          {createdKey && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="text-xs text-emerald-400 mb-1.5 flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" /> 密钥仅完整显示一次，请立即复制保存
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-zinc-950/80 border border-zinc-800 px-2.5 py-1.5 text-xs font-mono text-emerald-300">{createdKey}</code>
                <Button size="icon" variant="outline" onClick={() => copyKey(createdKey)} title="复制">
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
          {(keys ?? []).length === 0 ? (
            <EmptyState title="还没有注册密钥" description="签发一个密钥给新节点使用" />
          ) : (
            <div className="space-y-2">
              {(keys ?? []).map((k) => (
                <div key={k.id} className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Badge tone="info">{k.prefix}…</Badge>
                    <span className="text-sm text-zinc-300">{k.name}</span>
                    {!k.enabled && <Badge tone="danger">已吊销</Badge>}
                    <span className="text-xs text-zinc-600">创建于 {fmtRelative(k.createdAt)}{k.lastUsedAt ? ` · 最近使用 ${fmtRelative(k.lastUsedAt)}` : ' · 从未使用'}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <code className="hidden md:block rounded bg-zinc-900 border border-zinc-800 px-2 py-1 text-[10px] font-mono text-zinc-500">
                      omni-agent run -server &lt;URL&gt; -regkey &lt;此密钥&gt;
                    </code>
                    {k.enabled === true && (
                      <Button size="icon" variant="ghost" onClick={() => revokeKey(k.id)} title="吊销">
                        <Trash2 className="h-3.5 w-3.5 text-rose-400/70" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Webhook alerts */}
      <Card>
        <CardHeader title="离线告警推送" subtitle="节点离线时通过 Telegram 或通用 Webhook 通知" icon={<Bell className="h-4 w-4 text-amber-400" />} />
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <Label>推送渠道</Label>
              <Select value={hookType} onChange={(e) => setHookType(e.target.value)}>
                <option value="none">不推送</option>
                <option value="telegram">Telegram Bot</option>
                <option value="generic">通用 Webhook</option>
              </Select>
            </div>
            {hookType === 'telegram' && (
              <>
                <div className="sm:col-span-2">
                  <Label>Bot Token {hook?.hasBotToken && <span className="text-emerald-400">（已配置，留空保持不变）</span>}</Label>
                  <Input value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="123456:ABC-DEF…" type="password" />
                </div>
                <div>
                  <Label>Chat ID</Label>
                  <Input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-100123456789" />
                </div>
              </>
            )}
            {hookType === 'generic' && (
              <>
                <div className="sm:col-span-2">
                  <Label>Webhook URL</Label>
                  <Input value={genericUrl} onChange={(e) => setGenericUrl(e.target.value)} placeholder="https://your-endpoint.example.com/alert" />
                </div>
                <div>
                  <Label>签名密钥（可选）</Label>
                  <Input value={genericSecret} onChange={(e) => setGenericSecret(e.target.value)} type="password" placeholder="HMAC-SHA256 签名密钥" />
                </div>
              </>
            )}
          </div>
          {hookType !== 'none' && (
            <div className="flex gap-2">
              <Button size="sm" onClick={saveHook}>保存配置</Button>
              <Button size="sm" variant="outline" loading={testing} onClick={testHook}>
                <Send className="h-3.5 w-3.5" /> 发送测试消息
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* File transfer */}
      <Card>
        <CardHeader title="文件传输测试" subtitle="通过 FILE_TRANSFER 协议通道在任意在线节点上传/下载小文件（≤6MB）" icon={<FolderOpen className="h-4 w-4 text-violet-300" />} />
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label>目标节点</Label>
              <Select value={fileNode} onChange={(e) => setFileNode(e.target.value)}>
                <option value="">— 选择在线节点 —</option>
                {onlineNodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>下载：节点上的文件路径</Label>
              <div className="flex gap-1.5">
                <Input value={filePath} onChange={(e) => setFilePath(e.target.value)} className="font-mono text-xs" />
                <Button size="md" disabled={!fileNode || fileBusy} onClick={testDownload} className="shrink-0 whitespace-nowrap">
                  <FileDown className="h-4 w-4" /> 下载
                </Button>
              </div>
            </div>
            <div>
              <Label>上传：保存到节点的路径</Label>
              <div className="flex gap-1.5">
                <Input value={uploadPath} onChange={(e) => setUploadPath(e.target.value)} className="font-mono text-xs" />
                <label className={`inline-flex items-center h-9 px-3 rounded-lg text-xs border border-zinc-700 text-zinc-300 hover:border-cyan-500/50 cursor-pointer ${!fileNode || fileBusy ? 'opacity-50 pointer-events-none' : ''}`}>
                  上传
                  <input
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void testUpload(f);
                    }}
                  />
                </label>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader title="安全" subtitle="修改控制台管理员密码" icon={<ShieldCheck className="h-4 w-4 text-emerald-400" />} />
        <div className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label>当前密码</Label>
              <Input type="password" value={curPass} onChange={(e) => setCurPass(e.target.value)} autoComplete="current-password" />
            </div>
            <div>
              <Label>新密码（≥8 位）</Label>
              <Input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} autoComplete="new-password" />
            </div>
            <div>
              <Label>确认新密码</Label>
              <Input type="password" value={newPass2} onChange={(e) => setNewPass2(e.target.value)} autoComplete="new-password" />
            </div>
          </div>
          <div className="mt-3">
            <Button size="sm" variant="primary" loading={changing} onClick={changePassword}>更新密码</Button>
          </div>
        </div>
      </Card>

      {/* About */}
      <Card>
        <CardHeader title="关于" />
        <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs text-zinc-500">
          <div><div className="text-zinc-300 font-medium mb-0.5">OmniMesh</div>边缘节点指挥与自动化调度中枢</div>
          <div><div className="text-zinc-300 font-medium mb-0.5">控制平面</div>Cloudflare Workers + D1 + Durable Objects + R2</div>
          <div><div className="text-zinc-300 font-medium mb-0.5">受控端</div>Go 单文件二进制（Linux / Windows）</div>
          <div><div className="text-zinc-300 font-medium mb-0.5">协议</div>WebSocket JSON 信封 + 二进制流帧</div>
        </div>
      </Card>

      {nodes === null && <Spinner className="hidden" />}
    </div>
  );
}
