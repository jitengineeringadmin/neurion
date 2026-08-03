'use client';
import { useEffect, useState } from 'react';
import { ForumBoard } from '../../../components/forum/ForumBoard';
import { getProdToken } from '../../../lib/api';

/**
 * The forum is one place, not one per installation.
 *
 * Reading asks for nothing: it is the same public board the website shows, and
 * somebody who has just installed Neurion should be able to look things up
 * before deciding to join anything. Writing needs the network login — the same
 * line drawn everywhere else here: working on your own machine asks for no
 * account, taking part with other people does.
 */
export default function AppForumPage() {
  const [canPost, setCanPost] = useState(false);
  useEffect(() => {
    setCanPost(getProdToken() != null);
  }, []);
  return (
    <ForumBoard
      canPost={canPost}
      threadHref={(id) => `/app/forum/${id}`}
      // Where the network login actually is, rather than a local sign-in page
      // that has nothing to do with this.
      loginHref="/app/dashboard"
    />
  );
}
