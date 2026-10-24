BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[StaffGroup] (
    [id] NVARCHAR(64) NOT NULL,
    [name] NVARCHAR(80) NOT NULL,
    [description] NVARCHAR(255),
    [sortOrder] INT NOT NULL CONSTRAINT [StaffGroup_sortOrder_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [StaffGroup_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [StaffGroup_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[StaffGroupRule] (
    [id] NVARCHAR(64) NOT NULL,
    [groupId] NVARCHAR(64) NOT NULL,
    [contains] NVARCHAR(120) NOT NULL,
    CONSTRAINT [StaffGroupRule_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[StaffGroupMember] (
    [userId] NVARCHAR(64) NOT NULL,
    [groupId] NVARCHAR(64) NOT NULL,
    [include] BIT NOT NULL,
    CONSTRAINT [StaffGroupMember_pkey] PRIMARY KEY CLUSTERED ([userId],[groupId])
);

-- CreateTable
CREATE TABLE [dbo].[FormAudience] (
    [id] NVARCHAR(64) NOT NULL,
    [formKey] NVARCHAR(100) NOT NULL,
    [groupId] NVARCHAR(64),
    [userId] NVARCHAR(64),
    CONSTRAINT [FormAudience_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [StaffGroupRule_groupId_idx] ON [dbo].[StaffGroupRule]([groupId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormAudience_formKey_idx] ON [dbo].[FormAudience]([formKey]);

-- AddForeignKey
ALTER TABLE [dbo].[StaffGroupRule] ADD CONSTRAINT [StaffGroupRule_groupId_fkey] FOREIGN KEY ([groupId]) REFERENCES [dbo].[StaffGroup]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[StaffGroupMember] ADD CONSTRAINT [StaffGroupMember_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[StaffGroupMember] ADD CONSTRAINT [StaffGroupMember_groupId_fkey] FOREIGN KEY ([groupId]) REFERENCES [dbo].[StaffGroup]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[FormAudience] ADD CONSTRAINT [FormAudience_groupId_fkey] FOREIGN KEY ([groupId]) REFERENCES [dbo].[StaffGroup]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[FormAudience] ADD CONSTRAINT [FormAudience_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

