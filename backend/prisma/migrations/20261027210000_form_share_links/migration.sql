BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[FormEntry] ADD [shareLinkId] NVARCHAR(64),
[sharedById] NVARCHAR(64),
[sharedByName] NVARCHAR(255);

-- CreateTable
CREATE TABLE [dbo].[FormShareLink] (
    [id] NVARCHAR(64) NOT NULL,
    [formId] NVARCHAR(64) NOT NULL,
    [userId] NVARCHAR(64) NOT NULL,
    [userName] NVARCHAR(255) NOT NULL,
    [token] NVARCHAR(64) NOT NULL,
    [expiresAt] DATETIME2,
    [revokedAt] DATETIME2,
    [revokedByName] NVARCHAR(255),
    [entries] INT NOT NULL CONSTRAINT [FormShareLink_entries_df] DEFAULT 0,
    [lastUsedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FormShareLink_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [FormShareLink_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [FormShareLink_token_key] UNIQUE NONCLUSTERED ([token])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormShareLink_formId_userId_idx] ON [dbo].[FormShareLink]([formId], [userId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_formId_sharedById_idx] ON [dbo].[FormEntry]([formId], [sharedById]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

