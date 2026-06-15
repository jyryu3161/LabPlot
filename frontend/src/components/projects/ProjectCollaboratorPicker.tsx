'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, UserPlus, X } from 'lucide-react';
import { searchProjectUsers } from '@/lib/api';
import type { ProjectUserSearchItem } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Props = {
  selected: ProjectUserSearchItem[];
  onChange: (users: ProjectUserSearchItem[]) => void;
  label?: string;
  helper?: string;
};

export function ProjectCollaboratorPicker({
  selected,
  onChange,
  label = 'Collaborators',
  helper = 'Search approved users by name or email. Added users can view and edit this project.',
}: Props) {
  const [query, setQuery] = useState('');
  const selectedIds = useMemo(() => new Set(selected.map((user) => user.id)), [selected]);
  const { data: results = [], isFetching } = useQuery({
    queryKey: ['project-user-search', query],
    queryFn: () => searchProjectUsers(query),
    enabled: query.trim().length >= 2,
  });
  const filtered = results.filter((user) => !selectedIds.has(user.id));

  function add(user: ProjectUserSearchItem) {
    onChange([...selected, user]);
    setQuery('');
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{helper}</p>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search users..."
          className="pl-8"
        />
        {query.trim().length >= 2 && (
          <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border bg-background shadow-md">
            {isFetching ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">Searching...</div>
            ) : filtered.length ? (
              filtered.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => add(user)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{user.display_name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
                  </span>
                  <UserPlus className="h-4 w-4 shrink-0 text-primary" />
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-sm text-muted-foreground">No matching users</div>
            )}
          </div>
        )}
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selected.map((user) => (
            <Badge key={user.id} variant="secondary" className="gap-1">
              {user.display_name}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-4 w-4 p-0"
                onClick={() => onChange(selected.filter((item) => item.id !== user.id))}
                aria-label={`Remove ${user.display_name}`}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
