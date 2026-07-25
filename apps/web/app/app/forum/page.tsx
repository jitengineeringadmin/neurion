'use client';
import { ForumBoard } from '../../../components/forum/ForumBoard';

export default function AppForumPage() {
  return <ForumBoard canPost threadHref={(id) => `/app/forum/${id}`} loginHref="/login" />;
}
