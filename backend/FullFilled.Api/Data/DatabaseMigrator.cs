using Microsoft.EntityFrameworkCore;
using System.Data;

namespace FullFilled.Api.Data;

public static class DatabaseMigrator
{
    private sealed record Migration(int Version, string Name, Func<FullFilledDbContext, Task> Apply);

    private static readonly Migration[] Migrations =
    [
        new(1, "legacy-schema-baseline", ApplyLegacyBaselineAsync),
        new(2, "phase-zero-core-tables", ApplyPhaseZeroTablesAsync),
        new(3, "legacy-telemetry-backfill", BackfillLegacyTelemetryAsync),
        new(4, "phase-one-company-progression", ApplyPhaseOneProgressionAsync),
        new(5, "phase-five-driver-morale", ApplyPhaseFiveDriverMoraleAsync),
        new(6, "phase-six-route-mastery", ApplyPhaseSixRouteMasteryAsync),
        new(7, "phase-eight-tutorial-status", ApplyPhaseEightTutorialStatusAsync),
        new(8, "social-friendships", ApplySocialFriendshipsAsync),
        new(9, "licence-state-persistence", ApplyLicenceStatePersistenceAsync),
        new(10, "rival-pressure", ApplyRivalPressureAsync),
    ];

    public static async Task MigrateAsync(FullFilledDbContext db, CancellationToken cancellationToken = default)
    {
        await db.Database.EnsureCreatedAsync(cancellationToken);
        // Deploy: WAL modu eszamanli okuma+yazmada "database is locked" hatalarini azaltir;
        // busy_timeout kisa kilit yarislarinda istegi hemen dusurmek yerine bekletir.
        await db.Database.ExecuteSqlRawAsync("PRAGMA journal_mode=WAL", cancellationToken);
        await db.Database.ExecuteSqlRawAsync("PRAGMA busy_timeout=5000", cancellationToken);
        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TABLE IF NOT EXISTS SchemaMigrations (
                Version INTEGER NOT NULL PRIMARY KEY,
                Name TEXT NOT NULL,
                AppliedAtUtc TEXT NOT NULL
            )
            """, cancellationToken);

        var applied = await ReadAppliedVersionsAsync(db, cancellationToken);
        foreach (var migration in Migrations.Where(item => !applied.Contains(item.Version)).OrderBy(item => item.Version))
        {
            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            await migration.Apply(db);
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO SchemaMigrations (Version, Name, AppliedAtUtc) VALUES ({migration.Version}, {migration.Name}, {DateTime.UtcNow})",
                cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }

        await db.Database.ExecuteSqlRawAsync("PRAGMA optimize", cancellationToken);
    }

    private static async Task<HashSet<int>> ReadAppliedVersionsAsync(FullFilledDbContext db, CancellationToken cancellationToken)
    {
        var versions = new HashSet<int>();
        var connection = db.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT Version FROM SchemaMigrations";
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) versions.Add(reader.GetInt32(0));
        return versions;
    }

    private static async Task ApplyLegacyBaselineAsync(FullFilledDbContext db)
    {
        var columns = new (string Name, string Definition)[]
        {
            ("SaveVersion", "INTEGER NOT NULL DEFAULT 0"),
            ("OwnedBusesJson", "TEXT NOT NULL DEFAULT '[]'"),
            ("DriverAssignmentsJson", "TEXT NOT NULL DEFAULT '{}'"),
            ("DriverShiftMinutesJson", "TEXT NOT NULL DEFAULT '{}'"),
            ("ChanceGamesJson", "TEXT NOT NULL DEFAULT '{}'"),
            ("GameTimeMinutes", "TEXT NOT NULL DEFAULT '480'"),
            ("GameDay", "INTEGER NOT NULL DEFAULT 1"),
            ("HiredDriverId", "TEXT NULL"),
            ("SecondLineUnlocked", "INTEGER NOT NULL DEFAULT 0"),
            ("SecondLineHasDriver", "INTEGER NOT NULL DEFAULT 0"),
            ("Username", "TEXT NULL"),
            ("PasswordHash", "TEXT NULL"),
            ("AuthTokenHash", "TEXT NULL"),
            ("HasCheckpoint", "INTEGER NOT NULL DEFAULT 0"),
            ("SavedAtUtc", "TEXT NOT NULL DEFAULT '0001-01-01T00:00:00.0000000'"),
            ("TerminalUpgradesJson", "TEXT NOT NULL DEFAULT '[]'"),
            ("UnlockedRoutesJson", "TEXT NOT NULL DEFAULT '[\"starter-center\"]'"),
            ("ActiveRouteId", "TEXT NOT NULL DEFAULT 'starter-center'"),
            ("OwnedBusIdsJson", "TEXT NOT NULL DEFAULT '[\"hurda-mavi\"]'"),
            ("ActiveBusId", "TEXT NOT NULL DEFAULT 'hurda-mavi'"),
            ("BusUpgradesJson", "TEXT NOT NULL DEFAULT '{}'"),
            ("PassengersOnBoard", "INTEGER NOT NULL DEFAULT 0"),
            ("NextStopDropoffs", "INTEGER NOT NULL DEFAULT 0"),
        };

        foreach (var column in columns)
        {
            if (!await ColumnExistsAsync(db, "GameSaves", column.Name))
            {
                await ExecuteNonQueryAsync(db, $"ALTER TABLE GameSaves ADD COLUMN {column.Name} {column.Definition}");
            }
        }

        await ExecuteStatementsAsync(db,
            """CREATE TABLE IF NOT EXISTS CityEvents (Id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, HostPlayerId TEXT NOT NULL, ActorPlayerId TEXT NOT NULL, ActorUsername TEXT NULL, Type TEXT NOT NULL, Amount TEXT NOT NULL, CreatedAtUtc TEXT NOT NULL)""",
            """CREATE TABLE IF NOT EXISTS ChanceGameTransactions (Id TEXT NOT NULL PRIMARY KEY, PlayerId TEXT NOT NULL, ClientRequestId TEXT NOT NULL, GameId TEXT NOT NULL, RequestHash TEXT NOT NULL, ResponseJson TEXT NOT NULL, CreatedAtUtc TEXT NOT NULL)""",
            """CREATE TABLE IF NOT EXISTS TelemetryEvents (Id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, PlayerId TEXT NOT NULL, Type TEXT NOT NULL, DataJson TEXT NOT NULL, ClientAtUtc TEXT NOT NULL, CreatedAtUtc TEXT NOT NULL)""",
            """CREATE TABLE IF NOT EXISTS FeedbackEntries (Id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, PlayerId TEXT NOT NULL, Username TEXT NULL, Category TEXT NOT NULL, Message TEXT NOT NULL, ContextJson TEXT NOT NULL, CreatedAtUtc TEXT NOT NULL)""",
            "CREATE UNIQUE INDEX IF NOT EXISTS IX_ChanceGameTransactions_PlayerId_ClientRequestId ON ChanceGameTransactions (PlayerId, ClientRequestId)",
            "CREATE INDEX IF NOT EXISTS IX_TelemetryEvents_Type_CreatedAtUtc ON TelemetryEvents (Type, CreatedAtUtc)",
            "CREATE INDEX IF NOT EXISTS IX_TelemetryEvents_PlayerId ON TelemetryEvents (PlayerId)",
            "CREATE INDEX IF NOT EXISTS IX_FeedbackEntries_CreatedAtUtc ON FeedbackEntries (CreatedAtUtc)");
    }

    private static Task ApplyPhaseZeroTablesAsync(FullFilledDbContext db) => ExecuteStatementsAsync(db,
        """CREATE TABLE IF NOT EXISTS Companies (Id TEXT NOT NULL PRIMARY KEY, PlayerId TEXT NOT NULL, Name TEXT NOT NULL, CreatedAtUtc TEXT NOT NULL, UpdatedAtUtc TEXT NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS PlayerProgression (PlayerId TEXT NOT NULL PRIMARY KEY, Level INTEGER NOT NULL DEFAULT 1, Experience INTEGER NOT NULL DEFAULT 0, CreatedAtUtc TEXT NOT NULL, UpdatedAtUtc TEXT NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS PlayerAchievements (PlayerId TEXT NOT NULL, AchievementId TEXT NOT NULL, Progress INTEGER NOT NULL DEFAULT 0, UnlockedAtUtc TEXT NULL, UpdatedAtUtc TEXT NOT NULL, PRIMARY KEY (PlayerId, AchievementId))""",
        """CREATE TABLE IF NOT EXISTS GameSessions (Id TEXT NOT NULL PRIMARY KEY, PlayerId TEXT NOT NULL, CompanyId TEXT NULL, ClientBuild TEXT NOT NULL, DeviceClass TEXT NOT NULL, Locale TEXT NOT NULL, PlayerLevel INTEGER NOT NULL, StartedAtUtc TEXT NOT NULL, LastSeenAtUtc TEXT NOT NULL, EndedAtUtc TEXT NULL, DurationSeconds INTEGER NOT NULL DEFAULT 0)""",
        """CREATE TABLE IF NOT EXISTS GameplayEvents (Id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, PlayerId TEXT NOT NULL, SessionId TEXT NULL, IdempotencyKey TEXT NOT NULL, EventVersion INTEGER NOT NULL DEFAULT 1, Type TEXT NOT NULL, Category TEXT NOT NULL, DataJson TEXT NOT NULL, ClientBuild TEXT NOT NULL, DeviceClass TEXT NOT NULL, Locale TEXT NOT NULL, PlayerLevel INTEGER NOT NULL, CompanyId TEXT NULL, Amount TEXT NULL, Balance TEXT NULL, Source TEXT NULL, ItemId TEXT NULL, NumericValue REAL NULL, ClientAtUtc TEXT NOT NULL, CreatedAtUtc TEXT NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS ContractRuns (Id TEXT NOT NULL PRIMARY KEY, PlayerId TEXT NOT NULL, ContractId TEXT NOT NULL, IdempotencyKey TEXT NOT NULL, Status TEXT NOT NULL, ProgressJson TEXT NOT NULL, StartedAtUtc TEXT NOT NULL, CompletedAtUtc TEXT NULL)""",
        """CREATE TABLE IF NOT EXISTS ShiftResults (Id TEXT NOT NULL PRIMARY KEY, PlayerId TEXT NOT NULL, SessionId TEXT NULL, IdempotencyKey TEXT NOT NULL, GameDay INTEGER NOT NULL, Grade TEXT NOT NULL, Score TEXT NOT NULL, MoneyEarned TEXT NOT NULL, ExperienceEarned INTEGER NOT NULL, MetricsJson TEXT NOT NULL, CompletedAtUtc TEXT NOT NULL)""",
        "CREATE UNIQUE INDEX IF NOT EXISTS IX_Companies_PlayerId ON Companies (PlayerId)",
        "CREATE INDEX IF NOT EXISTS IX_GameSessions_PlayerId_StartedAtUtc ON GameSessions (PlayerId, StartedAtUtc)",
        "CREATE INDEX IF NOT EXISTS IX_GameSessions_StartedAtUtc ON GameSessions (StartedAtUtc)",
        "CREATE UNIQUE INDEX IF NOT EXISTS IX_GameplayEvents_PlayerId_IdempotencyKey ON GameplayEvents (PlayerId, IdempotencyKey)",
        "CREATE INDEX IF NOT EXISTS IX_GameplayEvents_Type_CreatedAtUtc ON GameplayEvents (Type, CreatedAtUtc)",
        "CREATE INDEX IF NOT EXISTS IX_GameplayEvents_PlayerId_CreatedAtUtc ON GameplayEvents (PlayerId, CreatedAtUtc)",
        "CREATE INDEX IF NOT EXISTS IX_GameplayEvents_SessionId ON GameplayEvents (SessionId)",
        "CREATE UNIQUE INDEX IF NOT EXISTS IX_ContractRuns_PlayerId_IdempotencyKey ON ContractRuns (PlayerId, IdempotencyKey)",
        "CREATE UNIQUE INDEX IF NOT EXISTS IX_ShiftResults_PlayerId_IdempotencyKey ON ShiftResults (PlayerId, IdempotencyKey)",
        "CREATE INDEX IF NOT EXISTS IX_ShiftResults_PlayerId_CompletedAtUtc ON ShiftResults (PlayerId, CompletedAtUtc)");

    private static Task BackfillLegacyTelemetryAsync(FullFilledDbContext db) => db.Database.ExecuteSqlRawAsync(
        """
        INSERT OR IGNORE INTO GameplayEvents
            (PlayerId, SessionId, IdempotencyKey, EventVersion, Type, Category, DataJson, ClientBuild,
             DeviceClass, Locale, PlayerLevel, CompanyId, Amount, Balance, Source, ItemId, NumericValue,
             ClientAtUtc, CreatedAtUtc)
        SELECT PlayerId, NULL, 'legacy:' || Id, 1, Type,
               CASE WHEN Type = 'fps_sample' THEN 'performance' WHEN Type = 'js_error' THEN 'error' ELSE 'gameplay' END,
               DataJson, 'legacy', 'unknown', 'tr', 1, NULL, NULL, NULL, NULL, NULL, NULL,
               ClientAtUtc, CreatedAtUtc
        FROM TelemetryEvents
        """);

    private static async Task ApplyPhaseOneProgressionAsync(FullFilledDbContext db)
    {
        var companyColumns = new (string Name, string Definition)[]
        {
            ("NormalizedName", "TEXT NOT NULL DEFAULT ''"),
            ("EmblemId", "TEXT NOT NULL DEFAULT 'route'"),
            ("PrimaryColor", "TEXT NOT NULL DEFAULT '#153448'"),
            ("SecondaryColor", "TEXT NOT NULL DEFAULT '#f4ead5'"),
            ("Strategy", "TEXT NOT NULL DEFAULT 'service'"),
            ("StarterBusId", "TEXT NOT NULL DEFAULT 'hurda-mavi'"),
            ("Reputation", "INTEGER NOT NULL DEFAULT 0"),
            ("SkillsJson", "TEXT NOT NULL DEFAULT '{}'"),
        };
        foreach (var column in companyColumns)
        {
            if (!await ColumnExistsAsync(db, "Companies", column.Name))
                await ExecuteNonQueryAsync(db, $"ALTER TABLE Companies ADD COLUMN {column.Name} {column.Definition}");
        }

        var progressionColumns = new (string Name, string Definition)[]
        {
            ("SkillPoints", "INTEGER NOT NULL DEFAULT 0"),
            ("LastAcknowledgedLevel", "INTEGER NOT NULL DEFAULT 1"),
        };
        foreach (var column in progressionColumns)
        {
            if (!await ColumnExistsAsync(db, "PlayerProgression", column.Name))
                await ExecuteNonQueryAsync(db, $"ALTER TABLE PlayerProgression ADD COLUMN {column.Name} {column.Definition}");
        }

        await ExecuteNonQueryAsync(db, "UPDATE Companies SET NormalizedName = lower(trim(Name)) WHERE NormalizedName = ''");
        await ExecuteNonQueryAsync(db, "CREATE UNIQUE INDEX IF NOT EXISTS IX_Companies_NormalizedName ON Companies (NormalizedName)");
    }

    private static async Task ApplyPhaseFiveDriverMoraleAsync(FullFilledDbContext db)
    {
        if (!await ColumnExistsAsync(db, "GameSaves", "DriverMoraleJson"))
            await ExecuteNonQueryAsync(db, "ALTER TABLE GameSaves ADD COLUMN DriverMoraleJson TEXT NOT NULL DEFAULT '{}'");
    }

    private static async Task ApplyPhaseSixRouteMasteryAsync(FullFilledDbContext db)
    {
        if (!await ColumnExistsAsync(db, "GameSaves", "RouteMasteryJson"))
            await ExecuteNonQueryAsync(db, "ALTER TABLE GameSaves ADD COLUMN RouteMasteryJson TEXT NOT NULL DEFAULT '{}'");
    }

    private static async Task ApplyPhaseEightTutorialStatusAsync(FullFilledDbContext db)
    {
        if (!await ColumnExistsAsync(db, "GameSaves", "TutorialStatusJson"))
            await ExecuteNonQueryAsync(db, "ALTER TABLE GameSaves ADD COLUMN TutorialStatusJson TEXT NOT NULL DEFAULT '{}'");
    }

    private static Task ApplySocialFriendshipsAsync(FullFilledDbContext db) => ExecuteStatementsAsync(db,
        """CREATE TABLE IF NOT EXISTS Friendships (Id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, PlayerId TEXT NOT NULL, FriendPlayerId TEXT NOT NULL, CreatedAtUtc TEXT NOT NULL)""",
        // Ayni ikili iki kez eklenemez; liste okumasi da PlayerId uzerinden filtreledigi icin ayrica indekslenir.
        "CREATE UNIQUE INDEX IF NOT EXISTS IX_Friendships_PlayerId_FriendPlayerId ON Friendships (PlayerId, FriendPlayerId)",
        "CREATE INDEX IF NOT EXISTS IX_Friendships_PlayerId ON Friendships (PlayerId)");
    /// Rakip firmanin hat basina baskisi: ihmal puani ve kaybedilen durak sayisi.
    private static async Task ApplyRivalPressureAsync(FullFilledDbContext db)
    {
        if (!await ColumnExistsAsync(db, "GameSaves", "RivalJson"))
            await ExecuteNonQueryAsync(db, "ALTER TABLE GameSaves ADD COLUMN RivalJson TEXT NOT NULL DEFAULT '{}'");
    }


    private static async Task ApplyLicenceStatePersistenceAsync(FullFilledDbContext db)
    {
        var columns = new (string Name, string Definition)[]
        {
            ("LicencePoints", "INTEGER NOT NULL DEFAULT 0"),
            ("PoliceRisk", "TEXT NOT NULL DEFAULT '0'"),
            ("ShortChangeStreak", "INTEGER NOT NULL DEFAULT 0"),
            ("VehicleLockSecondsLeft", "TEXT NOT NULL DEFAULT '0'"),
        };
        foreach (var column in columns)
        {
            if (!await ColumnExistsAsync(db, "GameSaves", column.Name))
                await ExecuteNonQueryAsync(db, $"ALTER TABLE GameSaves ADD COLUMN {column.Name} {column.Definition}");
        }
    }

    private static async Task<bool> ColumnExistsAsync(FullFilledDbContext db, string tableName, string columnName)
    {
        var connection = db.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA table_info({tableName})";
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            if (string.Equals(reader.GetString(1), columnName, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static async Task ExecuteStatementsAsync(FullFilledDbContext db, params string[] statements)
    {
        foreach (var statement in statements) await db.Database.ExecuteSqlRawAsync(statement);
    }

    private static async Task ExecuteNonQueryAsync(FullFilledDbContext db, string statement)
    {
        var connection = db.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = statement;
        await command.ExecuteNonQueryAsync();
    }
}
