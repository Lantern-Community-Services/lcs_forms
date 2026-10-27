BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Notification] ADD [emailDetail] NVARCHAR(max);

-- CreateTable
CREATE TABLE [dbo].[EmailLog] (
    [id] NVARCHAR(64) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [EmailLog_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [formId] NVARCHAR(64),
    [kind] NVARCHAR(32) NOT NULL,
    [to] NVARCHAR(320) NOT NULL,
    [subject] NVARCHAR(255) NOT NULL,
    [status] NVARCHAR(32) NOT NULL,
    [error] NVARCHAR(max),
    [withAnswers] BIT NOT NULL CONSTRAINT [EmailLog_withAnswers_df] DEFAULT 0,
    CONSTRAINT [EmailLog_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [EmailLog_formId_createdAt_idx] ON [dbo].[EmailLog]([formId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [EmailLog_createdAt_idx] ON [dbo].[EmailLog]([createdAt]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

