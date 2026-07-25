'use client';
import { ForumThread } from '../../../../components/forum/ForumThread';

export default function AppThreadPage() {
  return <ForumThread canPost backHref="/app/forum" loginHref="/login" />;
}
