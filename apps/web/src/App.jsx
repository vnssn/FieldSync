import { Link, Route, Routes } from 'react-router-dom';
import { lazy,Suspense } from 'react';
import { RequireSession, RequireAdmin } from './auth.jsx';
import { AppShell } from './components/AppShell.jsx';
import { AuthPage } from './pages/AuthPage.jsx';
const page=(load,name)=>lazy(()=>load().then((module)=>({ default:module[name] })));
const DashboardPage=page(()=>import('./pages/DashboardPage.jsx'),'DashboardPage');
const AssetsPage=page(()=>import('./pages/AssetsPage.jsx'),'AssetsPage');
const AssetDetailPage=page(()=>import('./pages/AssetDetailPage.jsx'),'AssetDetailPage');
const TeamPage=page(()=>import('./pages/TeamPage.jsx'),'TeamPage');
const SystemStatusPage=page(()=>import('./pages/SystemStatusPage.jsx'),'SystemStatusPage');
const TemplatesPage=page(()=>import('./pages/TemplatesPage.jsx'),'TemplatesPage');
const InspectionsPage=page(()=>import('./pages/InspectionsPage.jsx'),'InspectionsPage');
const InspectionDetailPage=page(()=>import('./pages/InspectionDetailPage.jsx'),'InspectionDetailPage');

export function App() {
  return <Suspense fallback={<p className="p-6 text-sm text-stone-500" role="status">Loading page…</p>}><Routes>
    <Route path="/login" element={<AuthPage key="login" />} />
    <Route path="/register" element={<AuthPage key="register" register />} />
    <Route element={<RequireSession />}><Route element={<AppShell />}>
      <Route index element={<DashboardPage />} />
      <Route path="assets" element={<AssetsPage />} />
      <Route path="assets/:id" element={<AssetDetailPage />} />
      <Route path="inspections" element={<InspectionsPage />} />
      <Route path="inspections/:id" element={<InspectionDetailPage />} />
      <Route path="status" element={<SystemStatusPage />} />
      <Route element={<RequireAdmin />}><Route path="team" element={<TeamPage />} /><Route path="templates" element={<TemplatesPage />} /></Route>
      <Route path="*" element={<div className="panel"><h1 className="text-2xl font-semibold">Page not found</h1><Link className="mt-4 inline-block underline" to="/">Return to dashboard</Link></div>} />
    </Route></Route>
  </Routes></Suspense>;
}
