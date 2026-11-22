import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { endpoints, setToken } from '../lib/api';
import { Button, Input, Label } from '../components/ui/ui';
import { Logo } from '../components/Shell';

export function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await endpoints.login(username, password);
      setToken(res.token);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[560px] h-[300px] rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute bottom-0 right-10 w-[420px] h-[240px] rounded-full bg-violet-500/10 blur-3xl" />
      </div>
      <div className="relative w-full max-w-sm animate-fade-up">
        <div className="flex flex-col items-center mb-7">
          <div className="rounded-2xl border border-zinc-800 bg-surface-raised p-3 shadow-glow">
            <Logo size={34} />
          </div>
          <h1 className="mt-4 text-xl font-bold tracking-wide text-zinc-50">OmniMesh</h1>
          <p className="text-xs text-zinc-500 mt-1">分布式边缘节点指挥与自动化调度中枢</p>
        </div>
        <form onSubmit={submit} className="panel p-6 space-y-4">
          <div>
            <Label>用户名</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" autoComplete="username" autoFocus />
          </div>
          <div>
            <Label>密码</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
          </div>
          {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>}
          <Button type="submit" variant="primary" className="w-full justify-center" loading={loading}>
            进入控制台
          </Button>
          <p className="text-center text-[11px] text-zinc-600">
            默认账号 admin / admin123 · 部署后请立即在「系统设置」中修改密码
          </p>
        </form>
      </div>
    </div>
  );
}
