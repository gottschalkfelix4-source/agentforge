import * as React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AuthGate, PublicOnly } from '@/features/auth/AuthGate';
import { LoginPage } from '@/features/auth/LoginPage';
import { SetupPage } from '@/features/auth/SetupPage';
import { AppShell } from '@/features/projects/AppShell';
import { HomePage } from '@/features/projects/HomePage';
import { ProjectView } from '@/features/projects/ProjectView';

const SettingsPage = React.lazy(() =>
  import('@/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

function Settings() {
  return (
    <React.Suspense fallback={null}>
      <SettingsPage />
    </React.Suspense>
  );
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/setup"
          element={
            <PublicOnly mode="setup">
              <SetupPage />
            </PublicOnly>
          }
        />
        <Route
          path="/login"
          element={
            <PublicOnly mode="login">
              <LoginPage />
            </PublicOnly>
          }
        />
        <Route
          element={
            <AuthGate>
              <AppShell />
            </AuthGate>
          }
        >
          <Route index element={<HomePage />} />
          <Route path="p/:projectId" element={<ProjectView />} />
          <Route path="settings" element={<Settings />} />
          <Route path="settings/:tab" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
