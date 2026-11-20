BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[FormEntry] ADD [signOffBackupAt] DATETIME2;

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_signOff_signOffBackupAt_idx] ON [dbo].[FormEntry]([signOff], [signOffBackupAt]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
