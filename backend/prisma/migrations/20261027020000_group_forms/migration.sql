BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[GroupForm] (
    [groupId] NVARCHAR(64) NOT NULL,
    [formKey] NVARCHAR(100) NOT NULL,
    CONSTRAINT [GroupForm_pkey] PRIMARY KEY CLUSTERED ([groupId],[formKey])
);

-- CreateTable
CREATE TABLE [dbo].[PersonForm] (
    [userId] NVARCHAR(64) NOT NULL,
    [formKey] NVARCHAR(100) NOT NULL,
    [include] BIT NOT NULL,
    CONSTRAINT [PersonForm_pkey] PRIMARY KEY CLUSTERED ([userId],[formKey])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [GroupForm_formKey_idx] ON [dbo].[GroupForm]([formKey]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PersonForm_formKey_idx] ON [dbo].[PersonForm]([formKey]);

-- AddForeignKey
ALTER TABLE [dbo].[GroupForm] ADD CONSTRAINT [GroupForm_groupId_fkey] FOREIGN KEY ([groupId]) REFERENCES [dbo].[StaffGroup]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[PersonForm] ADD CONSTRAINT [PersonForm_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
