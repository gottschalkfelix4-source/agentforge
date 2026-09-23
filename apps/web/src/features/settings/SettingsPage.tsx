import { useNavigate, useParams } from 'react-router';
import { Bot, Boxes, Cpu, Github, KeyRound } from 'lucide-react';
import { GitHubSettings } from '@/features/github/GitHubSettings';
import { AgentsTab } from '@/features/tools/AgentsTab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProvidersTab } from './ProvidersTab';
import { ProfilesTab } from './ProfilesTab';
import { SystemTab } from './SystemTab';

const TABS = ['providers', 'profiles', 'agents', 'github', 'system'] as const;
type Tab = (typeof TABS)[number];

export function SettingsPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const current: Tab = (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : 'providers';

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <h1 className="text-xl font-semibold">Einstellungen</h1>
        <p className="mt-1 text-sm text-muted-foreground">Provider, Agent-Profile, Agents, GitHub und Systemstatus.</p>
        <Tabs value={current} onValueChange={(v) => navigate(`/settings/${v}`, { replace: true })} className="mt-6">
          <TabsList>
            <TabsTrigger value="providers">
              <KeyRound className="size-3.5" /> Provider
            </TabsTrigger>
            <TabsTrigger value="profiles">
              <Bot className="size-3.5" /> Agent-Profile
            </TabsTrigger>
            <TabsTrigger value="agents">
              <Boxes className="size-3.5" /> Agents
            </TabsTrigger>
            <TabsTrigger value="github">
              <Github className="size-3.5" /> GitHub
            </TabsTrigger>
            <TabsTrigger value="system">
              <Cpu className="size-3.5" /> System
            </TabsTrigger>
          </TabsList>
          <TabsContent value="providers">
            <ProvidersTab />
          </TabsContent>
          <TabsContent value="profiles">
            <ProfilesTab />
          </TabsContent>
          <TabsContent value="agents">
            <AgentsTab />
          </TabsContent>
          <TabsContent value="github">
            <GitHubSettings />
          </TabsContent>
          <TabsContent value="system">
            <SystemTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
