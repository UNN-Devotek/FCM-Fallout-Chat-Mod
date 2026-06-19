import React from 'react';
import { createBrowserRouter, RouterProvider, Navigate, Outlet, useRouteError } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';

function RouteErrorDisplay() {
  const error = useRouteError();
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div style={{ padding: '24px', color: 'var(--phosphor-color)', fontFamily: 'monospace' }}>
      <div style={{ marginBottom: '8px', fontSize: '14px', letterSpacing: '2px' }}>ROUTE ERROR</div>
      <pre style={{ fontSize: '12px', color: 'rgba(255,68,68,0.9)', whiteSpace: 'pre-wrap' }}>{msg}</pre>
    </div>
  );
}
import AdminLayout from './components/AdminLayout';
import BannedSplash from './components/BannedSplash';
import LandingPage from './features/auth/LandingPage';
import LoginPage from './features/auth/LoginPage';
import LiveFeed from './features/chat/LiveFeed';
import Users from './features/moderation/Users';
import PlayerReports from './features/moderation/PlayerReports';
import BugReports from './features/moderation/BugReports';
import Applications from './features/moderation/Applications';
import Channels from './features/moderation/Channels';
import AutoModeration from './features/moderation/AutoModeration';
import AutoModViolations from './features/moderation/AutoModViolations';
import ChatCommands from './features/moderation/ChatCommands';
import NameBlacklist from './features/moderation/NameBlacklist';
import Bans from './features/moderation/Bans';
import BanForm from './features/moderation/BanForm';
import BanDetail from './features/moderation/BanDetail';
import Evidence from './features/moderation/Evidence';
import Voice from './features/moderation/Voice';
import EmbedBuilder from './features/moderation/EmbedBuilder';
import HelpPage from './features/system/HelpPage';
import KeybindsPage from './features/system/KeybindsPage';
import AuditLog from './features/system/AuditLog';
import ServerHealth from './features/system/ServerHealth';
import ChatOverlay from './features/chat/ChatOverlay';
import Profile from './features/profile/Profile';
import ReportPage from './features/public/ReportPage';
import ApplyPage from './features/public/ApplyPage';
import Devices from './features/system/Devices';
import WikiSync from './features/wiki/WikiSync';

const MOD_ROLES = ['owner', 'admin', 'moderator'];

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading" style={{ padding: '40px' }}>Initializing...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RoleGuard({ allowedRoles, children }: { allowedRoles: string[]; children: React.ReactNode }) {
  const { user } = useAuth();
  if (user && !allowedRoles.includes(user.role)) return <Navigate to="/chat" replace />;
  return <>{children}</>;
}

function DefaultRedirect() {
  const { user } = useAuth();
  const chatOnly = !user?.role || !MOD_ROLES.includes(user.role);
  return <Navigate to={chatOnly ? '/chat' : '/server-health'} replace />;
}

function AppRoot() {
  const { user } = useAuth();

  return (
    <AuthGate>
      <AdminLayout user={user}>
        <Outlet context={{ user }} />
      </AdminLayout>
    </AuthGate>
  );
}

const router = createBrowserRouter([
  /* Public routes */
  { path: '/', element: <LandingPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/report', element: <ReportPage /> },
  { path: '/apply', element: <ApplyPage /> },

  /* Protected admin routes */
  {
    element: <AppRoot />,
    errorElement: <RouteErrorDisplay />,
    children: [
      { path: '/chat', element: <ChatOverlay /> },
      { path: '/keybinds', element: <KeybindsPage /> },
      { path: '/profile/:userId', element: <Profile /> },
      { path: '/feed', element: <RoleGuard allowedRoles={MOD_ROLES}><LiveFeed /></RoleGuard> },
      { path: '/users', element: <RoleGuard allowedRoles={MOD_ROLES}><Users /></RoleGuard> },
      { path: '/channels', element: <RoleGuard allowedRoles={MOD_ROLES}><Channels /></RoleGuard>, errorElement: <RouteErrorDisplay /> },
      { path: '/moderation', element: <RoleGuard allowedRoles={MOD_ROLES}><AutoModeration /></RoleGuard> },
      { path: '/moderation/violations', element: <RoleGuard allowedRoles={MOD_ROLES}><AutoModViolations /></RoleGuard> },
      { path: '/commands', element: <RoleGuard allowedRoles={MOD_ROLES}><ChatCommands /></RoleGuard> },
      // Open to ANY authenticated user — the page itself branches on role:
      // staff get the full admin table, dwellers get the self-service "mine" view.
      { path: '/player-reports', element: <PlayerReports /> },
      { path: '/bug-reports', element: <BugReports /> },
      { path: '/applications', element: <Applications /> },
      { path: '/name-blacklist', element: <RoleGuard allowedRoles={MOD_ROLES}><NameBlacklist /></RoleGuard> },
      { path: '/moderation/bans', element: <RoleGuard allowedRoles={MOD_ROLES}><Bans /></RoleGuard> },
      { path: '/moderation/bans/new', element: <RoleGuard allowedRoles={MOD_ROLES}><BanForm /></RoleGuard> },
      { path: '/moderation/bans/:id', element: <RoleGuard allowedRoles={MOD_ROLES}><BanDetail /></RoleGuard> },
      { path: '/moderation/evidence', element: <RoleGuard allowedRoles={MOD_ROLES}><Evidence /></RoleGuard> },
      { path: '/voice', element: <RoleGuard allowedRoles={MOD_ROLES}><Voice /></RoleGuard> },
      { path: '/discord-embeds', element: <RoleGuard allowedRoles={MOD_ROLES}><EmbedBuilder /></RoleGuard> },
      { path: '/help', element: <HelpPage /> },
      { path: '/audit-log', element: <RoleGuard allowedRoles={MOD_ROLES}><AuditLog /></RoleGuard> },
      { path: '/server-health', element: <RoleGuard allowedRoles={MOD_ROLES}><ServerHealth /></RoleGuard> },
      { path: '/devices', element: <RoleGuard allowedRoles={MOD_ROLES}><Devices /></RoleGuard> },
      { path: '/wiki-sync', element: <RoleGuard allowedRoles={MOD_ROLES}><WikiSync /></RoleGuard> },
      { path: '*', element: <DefaultRedirect /> },
    ],
  },
]);

export default function App() {
  return (
    <>
      <RouterProvider router={router} />
      <BannedSplash />
    </>
  );
}
