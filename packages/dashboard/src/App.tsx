import { Routes, Route, Navigate } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Nodes } from './pages/Nodes';
import { NodeDetail } from './pages/NodeDetail';
import { Terminal } from './pages/Terminal';
import { Workflows } from './pages/Workflows';
import { WorkflowEditor } from './pages/WorkflowEditor';
import { WorkflowRunPage } from './pages/WorkflowRun';
import { CronJobs } from './pages/CronJobs';
import { AuditLogs } from './pages/AuditLogs';
import { Settings } from './pages/Settings';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Shell />}>
        <Route path="/" element={<Overview />} />
        <Route path="/nodes" element={<Nodes />} />
        <Route path="/nodes/:id" element={<NodeDetail />} />
        <Route path="/terminal" element={<Terminal />} />
        <Route path="/workflows" element={<Workflows />} />
        <Route path="/workflows/new" element={<WorkflowEditor />} />
        <Route path="/workflows/:id/edit" element={<WorkflowEditor />} />
        <Route path="/workflow-runs/:id" element={<WorkflowRunPage />} />
        <Route path="/cron" element={<CronJobs />} />
        <Route path="/audit" element={<AuditLogs />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
