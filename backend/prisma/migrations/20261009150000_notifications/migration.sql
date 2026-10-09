BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[User] ADD [notifyDigestAt] DATETIME2,
[notifyEmailMode] NVARCHAR(255) NOT NULL CONSTRAINT [User_notifyEmailMode_df] DEFAULT 'instant';

-- CreateTable
CREATE TABLE [dbo].[Notification] (
    [id] NVARCHAR(64) NOT NULL,
    [userId] NVARCHAR(64) NOT NULL,
    [type] NVARCHAR(255) NOT NULL,
    [title] NVARCHAR(255) NOT NULL,
    [body] NVARCHAR(max),
    [link] NVARCHAR(max),
    [source] NVARCHAR(255) NOT NULL CONSTRAINT [Notification_source_df] DEFAULT 'system',
    [sourceLabel] NVARCHAR(255),
    [formId] NVARCHAR(64),
    [inApp] BIT NOT NULL CONSTRAINT [Notification_inApp_df] DEFAULT 1,
    [readAt] DATETIME2,
    [emailStatus] NVARCHAR(255) NOT NULL CONSTRAINT [Notification_emailStatus_df] DEFAULT 'none',
    [emailError] NVARCHAR(max),
    [emailTries] INT NOT NULL CONSTRAINT [Notification_emailTries_df] DEFAULT 0,
    [emailedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Notification_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Notification_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[NotificationPref] (
    [userId] NVARCHAR(64) NOT NULL,
    [key] NVARCHAR(255) NOT NULL,
    [inApp] BIT NOT NULL CONSTRAINT [NotificationPref_inApp_df] DEFAULT 1,
    [email] BIT NOT NULL CONSTRAINT [NotificationPref_email_df] DEFAULT 0,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [NotificationPref_pkey] PRIMARY KEY CLUSTERED ([userId],[key])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Notification_userId_inApp_readAt_idx] ON [dbo].[Notification]([userId], [inApp], [readAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Notification_userId_createdAt_idx] ON [dbo].[Notification]([userId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Notification_emailStatus_createdAt_idx] ON [dbo].[Notification]([emailStatus], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Notification_createdAt_idx] ON [dbo].[Notification]([createdAt]);

-- AddForeignKey
ALTER TABLE [dbo].[Notification] ADD CONSTRAINT [Notification_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[NotificationPref] ADD CONSTRAINT [NotificationPref_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

