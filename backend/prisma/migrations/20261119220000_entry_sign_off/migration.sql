BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[FormEntry] ADD [signOff] NVARCHAR(16),
[signOffs] NVARCHAR(max),
[signOffRemindedAt] DATETIME2,
[signOffReminders] INT NOT NULL CONSTRAINT [FormEntry_signOffReminders_df] DEFAULT 0;

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_formId_signOff_idx] ON [dbo].[FormEntry]([formId], [signOff]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
