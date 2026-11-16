import { Link, Route, Routes } from 'react-router-dom';
import { RequireSession, RequireAdmin } from './auth.jsx';
import { AppShell } from './components/AppShell.jsx';
import { AuthPage } from './pages/AuthPage.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { AssetsPage } from './pages/AssetsPage.jsx';
import { AssetDetailPage } from './pages/AssetDetailPage.jsx';
import { TeamPage } from './pages/TeamPage.jsx';
import { SystemStatusPage } from './pages/SystemStatusPage.jsx';

export function App() {
  return <Routes>
    <Route path="/login" element={<AuthPage key="login" />} />
    <Route path="/register" element={<AuthPage key="register" register />} />
    <Route element={<RequireSession />}><Route element={<AppShell />}>
      <Route index element={<DashboardPage />} />
      <Route path="assets" element={<AssetsPage />} />
      <Route path="assets/:id" element={<AssetDetailPage />} />
      <Route path="status" element={<SystemStatusPage />} />
      <Route element={<RequireAdmin />}><Route path="team" element={<TeamPage />} /></Route>
      <Route path="*" element={<div className="panel"><h1 className="text-2xl font-semibold">Page not found</h1><Link className="mt-4 inline-block underline" to="/">Return to dashboard</Link></div>} />
    </Route></Route>
  </Routes>;
}
