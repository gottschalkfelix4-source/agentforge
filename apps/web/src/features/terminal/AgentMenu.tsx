import { useNavigate } from 'react-router';
import { Bot, ChevronDown, KeyRound, Loader2, Play, Settings2, UserCog } from 'lucide-react';
import type { CreateTerminalRequest } from '@vibe/shared';
import { useAgents, useProfiles } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function AgentMenu({
  disabled,
  busy,
  onLaunch,
}: {
  disabled?: boolean;
  busy?: boolean;
  onLaunch: (req: CreateTerminalRequest) => void;
}) {
  const agents = useAgents();
  const profiles = useProfiles();
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="brand" size="sm" disabled={disabled} className="gap-1 pr-1.5">
          {busy ? <Loader2 className="animate-spin" /> : <Bot />}
          Agent starten
          <ChevronDown className="size-3.5 opacity-80" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Coding-Agents</DropdownMenuLabel>
        {agents.isPending && (
          <DropdownMenuItem disabled>
            <Loader2 className="animate-spin" /> Lade…
          </DropdownMenuItem>
        )}
        {agents.isError && <DropdownMenuItem disabled>Agents konnten nicht geladen werden</DropdownMenuItem>}
        {agents.data?.map((agent) => {
          const agentProfiles = (profiles.data ?? []).filter((p) => p.agentKind === agent.id);
          return (
            <DropdownMenuSub key={agent.id}>
              <DropdownMenuSubTrigger>
                <Bot /> {agent.label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                <DropdownMenuItem onSelect={() => onLaunch({ kind: 'agent', agentId: agent.id, mode: 'run' })}>
                  <Play /> Starten
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <UserCog /> Starten mit Profil…
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56">
                    {agentProfiles.length === 0 ? (
                      <DropdownMenuItem disabled>Keine Profile für {agent.label}</DropdownMenuItem>
                    ) : (
                      agentProfiles.map((p) => (
                        <DropdownMenuItem
                          key={p.id}
                          onSelect={() => onLaunch({ kind: 'agent', agentId: agent.id, mode: 'run', profileId: p.id })}
                        >
                          <span className="truncate">{p.name}</span>
                          <span className="ml-auto text-[11px] text-muted-foreground">
                            {p.authMode === 'subscription' ? 'Abo' : (p.model ?? 'API')}
                          </span>
                        </DropdownMenuItem>
                      ))
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => navigate('/settings/profiles')}>
                      <Settings2 /> Profile verwalten
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!agent.loginCommand}
                  onSelect={() => onLaunch({ kind: 'agent', agentId: agent.id, mode: 'login' })}
                >
                  <KeyRound /> Anmelden (Abo-Login)
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
