BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[FormEntry] ADD [followUp] NVARCHAR(16),
[followUpDoneAt] DATETIME2,
[followUpDoneByName] NVARCHAR(255),
[followUpNote] NVARCHAR(2000),
[followUpRemindedAt] DATETIME2,
[followUpReminders] INT NOT NULL CONSTRAINT [FormEntry_followUpReminders_df] DEFAULT 0;

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_formId_followUp_idx] ON [dbo].[FormEntry]([formId], [followUp]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

