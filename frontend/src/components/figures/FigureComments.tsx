'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { addFigureComment, deleteFigureComment, listFigureComments } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, MessageSquare, Trash2 } from 'lucide-react';

/** Discussion thread for a figure: list (oldest first), add, and delete own comments. */
export function FigureComments({ figureId }: { figureId: string }) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const { data: comments, isLoading, isError } = useQuery({
    queryKey: ['figure-comments', figureId],
    queryFn: () => listFigureComments(figureId),
  });

  const addComment = useMutation({
    mutationFn: () => addFigureComment(figureId, body.trim()),
    onSuccess: () => {
      setBody('');
      toast.success('Comment added');
      qc.invalidateQueries({ queryKey: ['figure-comments', figureId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Comment failed'),
  });

  const removeComment = useMutation({
    mutationFn: (commentId: string) => deleteFigureComment(figureId, commentId),
    onSuccess: () => {
      toast.success('Comment deleted');
      qc.invalidateQueries({ queryKey: ['figure-comments', figureId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Comment delete failed'),
  });

  const count = comments?.length ?? 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquare className="h-4 w-4" /> Comments ({count})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : isError ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">Could not load comments. Try reloading the page.</p>
        ) : count === 0 ? (
          <p className="text-sm text-muted-foreground">No comments yet. Start the discussion below.</p>
        ) : (
          <div className="space-y-2">
            {(comments ?? []).map((c) => (
              <div key={c.id} className="rounded-md border p-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate font-medium text-foreground">{c.author_name}</span>
                  <span className="shrink-0">{new Date(c.created_at).toLocaleString()}</span>
                  {c.can_delete && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="ml-auto shrink-0"
                      aria-label="Delete comment"
                      disabled={removeComment.isPending}
                      onClick={() => { if (confirm('Delete this comment?')) removeComment.mutate(c.id); }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">{c.body}</p>
              </div>
            ))}
          </div>
        )}
        <form
          className="space-y-2"
          onSubmit={(e) => { e.preventDefault(); if (body.trim()) addComment.mutate(); }}
        >
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Add a comment for collaborators…"
            aria-label="New comment"
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!body.trim() || addComment.isPending}>
              {addComment.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Post comment
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
