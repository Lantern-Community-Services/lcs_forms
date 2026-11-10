BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[CalendarEvent] ADD [feeds] NVARCHAR(max);

-- AlterTable
ALTER TABLE [dbo].[CalendarOutlookTrash] ALTER COLUMN [ownerId] NVARCHAR(320) NOT NULL;

-- CreateTable
CREATE TABLE [dbo].[CalendarMailboxCopy] (
    [id] NVARCHAR(64) NOT NULL,
    [eventId] NVARCHAR(64) NOT NULL,
    [mailbox] NVARCHAR(255) NOT NULL,
    [outlookEventId] NVARCHAR(512),
    [hash] NVARCHAR(64),
    [error] NVARCHAR(max),
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [CalendarMailboxCopy_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CalendarMailboxCopy_eventId_mailbox_key] UNIQUE NONCLUSTERED ([eventId],[mailbox])
);

-- AddForeignKey
ALTER TABLE [dbo].[CalendarMailboxCopy] ADD CONSTRAINT [CalendarMailboxCopy_eventId_fkey] FOREIGN KEY ([eventId]) REFERENCES [dbo].[CalendarEvent]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

