BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[User] ADD [notifyDigestHour] INT;

-- AlterTable
ALTER TABLE [dbo].[Notification] ADD [topic] NVARCHAR(255);

-- AlterTable
ALTER TABLE [dbo].[NotificationPref] ADD [emailWhen] NVARCHAR(16);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Notification_userId_topic_idx] ON [dbo].[Notification]([userId], [topic]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
