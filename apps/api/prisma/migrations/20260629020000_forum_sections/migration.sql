-- ForumSection (seeded board sections)
CREATE TABLE "ForumSection" (
    "id" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ForumSection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ForumSection_group_order_idx" ON "ForumSection"("group", "order");

INSERT INTO "ForumSection" ("id","group","name","description","icon","order") VALUES
('announcements','Start here','Announcements','Official news and releases from the Neurion team','📣',1),
('introductions','Start here','Introductions','New here? Say hello and tell the community about yourself','👋',2),
('guides-faq','Start here','Guides & FAQ','How-tos, tips and frequently asked questions','📚',3),
('run-a-node','Network & Nodes','Running a node','Set up your node, hardware/GPU, troubleshooting and earnings','⚡',4),
('rewards-nrn','Network & Nodes','Rewards & NRN','Credits, NRN payouts and on-chain questions','🪙',5),
('verification-trust','Network & Nodes','Verification & Trust','Compute verification, reputation and disputes','🛡️',6),
('chat-agent','Using Neurion','Chat & Agent','Using the AI chat and the multi-step agent','💬',7),
('models','Using Neurion','AI Models','Which model to run, performance and downloads','🧠',8),
('desktop-app','Using Neurion','Desktop App','Install and support for Windows, macOS and Linux','🖥️',9),
('dev-api','Build & Community','Development & API','Integrations, the API and contributing','🛠️',10),
('ideas','Build & Community','Ideas & Feedback','Feature requests and proposals','💡',11),
('offtopic','Build & Community','Off-topic','Anything else — community chat','🎲',12)
ON CONFLICT ("id") DO NOTHING;

-- ForumThread: replace the category enum with a section FK
ALTER TABLE "ForumThread" ADD COLUMN "sectionId" TEXT;
UPDATE "ForumThread" SET "sectionId" = CASE "category"
  WHEN 'ANNOUNCEMENTS' THEN 'announcements'
  WHEN 'NODES' THEN 'run-a-node'
  WHEN 'SUPPORT' THEN 'guides-faq'
  WHEN 'IDEAS' THEN 'ideas'
  ELSE 'offtopic' END;
ALTER TABLE "ForumThread" ALTER COLUMN "sectionId" SET NOT NULL;
DROP INDEX IF EXISTS "ForumThread_category_lastActivityAt_idx";
ALTER TABLE "ForumThread" DROP COLUMN "category";
DROP TYPE "ForumCategory";
CREATE INDEX "ForumThread_sectionId_lastActivityAt_idx" ON "ForumThread"("sectionId", "lastActivityAt");
ALTER TABLE "ForumThread" ADD CONSTRAINT "ForumThread_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "ForumSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
