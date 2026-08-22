using FullFilled.Api;
using FullFilled.Api.Data;
using FullFilled.Api.Dtos;
using FullFilled.Api.Models;
using FullFilled.Api.Services;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using System.Security.Cryptography;

var builder = WebApplication.CreateBuilder(args);

// Sunucu logları container/VPS standardı olan stdout'a gider. Windows Event Log sağlayıcısı
// kısıtlı servis hesaplarında log yazarken isteğin kendisini düşürebildiği için kullanılmaz.
builder.Logging.ClearProviders();
builder.Logging.AddConsole();

builder.Services.AddOpenApi();

// Deploy: izinli origin'ler config'den gelir (Cors:AllowedOrigins / Cors__AllowedOrigins__0 env).
// Liste boşsa yalnızca yerel geliştirme origin'leri kabul edilir — production'da origin listesi
// vermeden yayına çıkmak, frontend'in tüm isteklerinin CORS'ta reddedilmesi demektir.
var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? [];
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy
            .SetIsOriginAllowed(origin =>
            {
                if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri)) return false;
                if (allowedOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase)) return true;
                return uri.Scheme == Uri.UriSchemeHttp &&
                       (uri.Host == "localhost" || uri.Host == "127.0.0.1");
            })
            .AllowAnyHeader()
            .AllowAnyMethod());
});

// Deploy: login brute-force koruması. IP başına dakikada sınırlı deneme; diğer uçlar için
// istemcinin normal oyun trafiğini (autosave + telemetri + oyun aksiyonları) rahat karşılayan
// genel bir tavan. Sınırlar appsettings üzerinden ezilebilir.
var loginRateLimit = builder.Configuration.GetValue("RateLimits:LoginPerMinute", 10);
var generalRateLimit = builder.Configuration.GetValue("RateLimits:GeneralPerMinute", 300);
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.GlobalLimiter = System.Threading.RateLimiting.PartitionedRateLimiter.Create<HttpContext, string>(context =>
        System.Threading.RateLimiting.RateLimitPartition.GetFixedWindowLimiter(
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new System.Threading.RateLimiting.FixedWindowRateLimiterOptions
            {
                PermitLimit = generalRateLimit,
                Window = TimeSpan.FromMinutes(1),
            }));
    options.AddPolicy("login", context =>
        System.Threading.RateLimiting.RateLimitPartition.GetFixedWindowLimiter(
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new System.Threading.RateLimiting.FixedWindowRateLimiterOptions
            {
                PermitLimit = loginRateLimit,
                Window = TimeSpan.FromMinutes(1),
            }));
});
builder.Services.AddDbContext<FullFilledDbContext>(options =>
    options.UseSqlite(builder.Configuration.GetConnectionString("Default") ?? "Data Source=fullfilled.db"));
builder.Services.AddScoped<TelemetryIngestionService>();
builder.Services.AddScoped<AnalyticsService>();
builder.Services.AddScoped<ProgressionService>();

// Faz 2: bozuk/dengesiz economy.json ile sunucu yanlış tahsilat yapmasın diye açılışta fail-fast.
EconomyConstants.Validate();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<FullFilledDbContext>();
    await DatabaseMigrator.MigrateAsync(db);
}

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

if (builder.Configuration.GetValue("HttpsRedirection:Enabled", false))
{
    app.UseHttpsRedirection();
}

if (!app.Environment.IsDevelopment())
{
    // Production'da beklenmeyen hatalar istemciye stack trace yerine sade bir 500 döndürür.
    app.UseExceptionHandler(errorApp => errorApp.Run(context =>
    {
        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        return context.Response.WriteAsJsonAsync(new { messageKey = "error.unexpected" });
    }));
}
app.UseCors();
app.UseRateLimiter();

// Deploy: yük dengeleyici / uptime monitörü için hafif sağlık ucu. Veritabanına dokunmaz;
// süreç ayakta ve ekonomi konfigürasyonu yüklüyse 200 döner.
app.MapGet("/health", () => Results.Ok(new { status = "ok" })).WithName("Health");
app.MapGet("/health/ready", async (FullFilledDbContext db, CancellationToken cancellationToken) =>
    await db.Database.CanConnectAsync(cancellationToken)
        ? Results.Ok(new { status = "ok", database = "connected" })
        : Results.Json(new { status = "unavailable", database = "disconnected" }, statusCode: 503))
    .WithName("Readiness");

// ---- Login: yalnızca kullanıcı adı + şifre (bkz. docs/game-design/07-hesap-giris.md) ----
// Kullanıcı adı yoksa otomatik kayıt olur; varsa şifre doğrulanır. Kullanıcıyı ayrı bir
// "kayıt ol" ekranına boğmamak için bilinçli olarak tek uç nokta.

app.MapPost("/api/auth/login", async (LoginRequest request, FullFilledDbContext db) =>
{
    var normalized = request.Username.Trim().ToLowerInvariant();
    if (normalized.Length < 3 || normalized.Length > 20 || !System.Text.RegularExpressions.Regex.IsMatch(normalized, "^[a-z0-9_]+$"))
    {
        return Results.BadRequest(new { messageKey = "auth.error.username" });
    }
    if (request.Password.Length < 4)
    {
        return Results.BadRequest(new { messageKey = "auth.error.password" });
    }

    var existing = await db.GameSaves.FirstOrDefaultAsync(s => s.Username == normalized);

    if (existing is null)
    {
        var authToken = CreateAuthToken();
        var save = new GameSave
        {
            SaveVersion = SchemaVersions.CurrentGameSave,
            PlayerId = Guid.NewGuid().ToString(),
            Username = normalized,
            PasswordHash = PasswordHasher.Hash(request.Password),
            AuthTokenHash = PasswordHasher.Hash(authToken),
            SavedAtUtc = DateTime.UtcNow,
            // Ekonomi varsayılanları — bunlar olmadan C#'ın 0 varsayılanı ilk AutoSave
            // çekişinde oyunun başlangıç değerlerini (koltuk, memnuniyet) ezerdi.
            SeatCapacity = EconomyConstants.BaseSeatCapacity,
            Satisfaction = EconomyConstants.InitialSatisfaction,
            StopsWaitingJson = "[]",
            OwnedBusesJson = "[]",
            DriverAssignmentsJson = "{}",
            DriverShiftMinutesJson = "{}",
            DriverMoraleJson = "{}",
            RouteMasteryJson = "{}",
            TutorialStatusJson = "{}",
            ChanceGamesJson = "{}",
            GameTimeMinutes = 480m,
            GameDay = 1,
            TerminalUpgradesJson = "[]",
            UnlockedRoutesJson = "[\"starter-center\"]",
            ActiveRouteId = "starter-center",
            OwnedBusIdsJson = "[\"hurda-mavi\"]",
            ActiveBusId = "hurda-mavi",
        };
        db.GameSaves.Add(save);
        await EnsurePlayerFoundationAsync(save, db, isNewAccount: true);
        await db.SaveChangesAsync();
        return Results.Ok(new LoginResponse(save.PlayerId, normalized, true, authToken));
    }

    if (string.IsNullOrEmpty(existing.PasswordHash) || !PasswordHasher.Verify(request.Password, existing.PasswordHash))
    {
        return Results.Json(new { messageKey = "auth.error.credentials" }, statusCode: 401);
    }

    var refreshedToken = CreateAuthToken();
    existing.AuthTokenHash = PasswordHasher.Hash(refreshedToken);
    existing.SaveVersion = SchemaVersions.CurrentGameSave;
    await EnsurePlayerFoundationAsync(existing, db, isNewAccount: false);
    await db.SaveChangesAsync();

    return Results.Ok(new LoginResponse(existing.PlayerId, normalized, false, refreshedToken));
})
.WithName("Login")
.RequireRateLimiting("login");

app.MapPost("/api/auth/logout/{playerId}", async (string playerId, FullFilledDbContext db, HttpContext httpContext) =>
{
    var auth = await FindAuthorizedSave(playerId, db, httpContext);
    if (auth.Result is not null) return auth.Result;

    auth.Save!.AuthTokenHash = null;
    await db.SaveChangesAsync();
    return Results.NoContent();
})
.WithName("Logout");

app.MapGet("/api/saves/{playerId}", async (string playerId, FullFilledDbContext db, HttpContext httpContext, bool includeOfflineIncome = true) =>
{
    var auth = await FindAuthorizedSave(playerId, db, httpContext);
    if (auth.Result is not null) return auth.Result;
    var save = auth.Save!;

    // Çevrimdışı gelir: yalnızca şoförü olan oyuncular için, sunucu saatine göre (bkz. ADR-002).
    // Not: hangi dolmuşçu tutulduğu fark etmeksizin ortalama bir oran kullanılır (MVP sadeliği).
    var offlineIncome = 0m;
    if (includeOfflineIncome && (!string.IsNullOrEmpty(save.HiredDriverId) || HasDriverAssignments(save.DriverAssignmentsJson)))
    {
        var elapsedSeconds = Math.Max(0, (DateTime.UtcNow - save.SavedAtUtc).TotalSeconds);
        var cappedSeconds = Math.Min(elapsedSeconds, EconomyConstants.OfflineIncomeCapHours * 3600);
        offlineIncome = CalculateOfflineShiftIncome(save, cappedSeconds);
        if (offlineIncome > 0)
        {
            save.Money += offlineIncome;
            save.SavedAtUtc = DateTime.UtcNow;
            await db.SaveChangesAsync();
        }
    }

    return Results.Ok(ToResponse(save, clamped: false, offlineIncome));
})
.WithName("GetGameSave");

app.MapPut("/api/saves/{playerId}", async (string playerId, SaveGameRequest request, FullFilledDbContext db, HttpContext httpContext) =>
{
    var auth = await FindAuthorizedSave(playerId, db, httpContext);
    if (auth.Result is not null) return auth.Result;
    var existing = auth.Save ?? throw new InvalidOperationException("Authorized save could not be resolved.");
    var now = DateTime.UtcNow;
    var progression = await db.PlayerProgression.FindAsync(playerId);
    var unlockedMilestones = await db.PlayerAchievements
        .Where(item => item.PlayerId == playerId && item.UnlockedAtUtc != null)
        .Select(item => item.AchievementId)
        .ToHashSetAsync();
    bool CanUse(string unlockId) => IsProgressionUnlockAvailable(unlockId, progression?.Level ?? 1, unlockedMilestones);

    var clampedMoney = request.Money;
    var clamped = false;

    var elapsedSeconds = Math.Max(0, (now - existing.SavedAtUtc).TotalSeconds);
    var maxPlausibleDelta = (decimal)elapsedSeconds * EconomyConstants.MaxPlausibleMoneyPerSecond;
    var delta = request.Money - existing.Money;
    if (delta > maxPlausibleDelta)
    {
        clampedMoney = existing.Money + maxPlausibleDelta;
        clamped = true;
    }

    // Snapshot yeni ilerleme alanlari getiriyorsa maliyeti sunucudaki son bakiyeden tahsil et.
    // Seviye/listeler geriye alinmaz; gecersiz veya karsilanamayan ilerleme yok sayilir.
    // Client earnings are accepted only up to maxPlausibleDelta above. Include that
    // validated gain in the purchase budget; using only existing.Money made every
    // normal fare increase collapse back to the previous balance (often zero).
    // When the client balance is lower because of a purchase, the old balance stays
    // as the budget so the server can verify and charge that purchase exactly once.
    var progressionBudget = Math.Max(existing.Money, clampedMoney);
    var savedBusUpgrades = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, UpgradesDto>>(existing.BusUpgradesJson)
        ?? new Dictionary<string, UpgradesDto>();
    if (!savedBusUpgrades.ContainsKey(existing.ActiveBusId))
    {
        savedBusUpgrades[existing.ActiveBusId] = new UpgradesDto(existing.MotorLevel, existing.SeatLevel, existing.SoundLevel, existing.HasCashRegister);
    }
    var savedOwnedBusIds = System.Text.Json.JsonSerializer.Deserialize<List<string>>(existing.OwnedBusIdsJson) ?? ["hurda-mavi"];
    var requestedActiveBusId = !string.IsNullOrWhiteSpace(request.ActiveBusId) &&
        (savedOwnedBusIds.Contains(request.ActiveBusId) || (request.OwnedBusIds ?? []).Contains(request.ActiveBusId))
            ? request.ActiveBusId
            : existing.ActiveBusId;
    var activeSavedUpgrades = savedBusUpgrades.GetValueOrDefault(requestedActiveBusId)
        ?? new UpgradesDto(0, 0, 0, false);

    var requestedMotorLevel = Math.Clamp(request.Upgrades.MotorLevel, activeSavedUpgrades.MotorLevel, EconomyConstants.MaxMotorLevel);
    if (requestedMotorLevel > activeSavedUpgrades.MotorLevel && !CanUse("upgrades")) { requestedMotorLevel = activeSavedUpgrades.MotorLevel; clamped = true; }
    var motorCost = EconomyConstants.MotorUpgradeCost(activeSavedUpgrades.MotorLevel, requestedMotorLevel);
    var motorLevel = requestedMotorLevel;
    if (progressionBudget < motorCost) { motorLevel = activeSavedUpgrades.MotorLevel; clamped = true; }
    else progressionBudget -= motorCost;

    var requestedSeatLevel = Math.Clamp(request.Upgrades.SeatLevel, activeSavedUpgrades.SeatLevel, EconomyConstants.MaxSeatLevel);
    if (requestedSeatLevel > activeSavedUpgrades.SeatLevel && !CanUse("upgrades")) { requestedSeatLevel = activeSavedUpgrades.SeatLevel; clamped = true; }
    var seatCost = EconomyConstants.SeatUpgradeCost(activeSavedUpgrades.SeatLevel, requestedSeatLevel);
    var seatLevel = requestedSeatLevel;
    if (progressionBudget < seatCost) { seatLevel = activeSavedUpgrades.SeatLevel; clamped = true; }
    else progressionBudget -= seatCost;

    var requestedSoundLevel = Math.Clamp(request.Upgrades.SoundLevel, activeSavedUpgrades.SoundLevel, EconomyConstants.MaxSoundLevel);
    if (requestedSoundLevel > activeSavedUpgrades.SoundLevel && !CanUse("upgrades")) { requestedSoundLevel = activeSavedUpgrades.SoundLevel; clamped = true; }
    var soundCost = EconomyConstants.SoundUpgradeCost(activeSavedUpgrades.SoundLevel, requestedSoundLevel);
    var soundLevel = requestedSoundLevel;
    if (progressionBudget < soundCost) { soundLevel = activeSavedUpgrades.SoundLevel; clamped = true; }
    else progressionBudget -= soundCost;

    var hasCashRegister = activeSavedUpgrades.HasCashRegister;
    if (!hasCashRegister && request.Upgrades.HasCashRegister && CanUse("upgrades"))
    {
        if (progressionBudget < EconomyConstants.CashRegisterCost) clamped = true;
        else { progressionBudget -= EconomyConstants.CashRegisterCost; hasCashRegister = true; }
    }

    var hiredDriverId = existing.HiredDriverId;
    if (request.HiredDriverId is null)
    {
        hiredDriverId = null;
    }
    else if (request.HiredDriverId != existing.HiredDriverId)
    {
        var hireCost = EconomyConstants.DriverHireCost(request.HiredDriverId);
        if (!CanUse("drivers") || existing.HiredDriverId is not null || hireCost is null || progressionBudget < hireCost.Value)
        {
            clamped = true;
        }
        else
        {
            progressionBudget -= hireCost.Value;
            hiredDriverId = request.HiredDriverId;
        }
    }

    var secondLineUnlocked = existing.SecondLineUnlocked;
    var secondLineHasDriver = existing.SecondLineHasDriver;
    if (!secondLineUnlocked && request.SecondLine.Unlocked)
    {
        if (!CanUse("routes") || progressionBudget < EconomyConstants.SecondLineOpenCost) clamped = true;
        else { progressionBudget -= EconomyConstants.SecondLineOpenCost; secondLineUnlocked = true; }
    }
    if (secondLineUnlocked && !secondLineHasDriver && request.SecondLine.HasDriver)
    {
        if (progressionBudget < EconomyConstants.SecondLineDriverHireCost) clamped = true;
        else { progressionBudget -= EconomyConstants.SecondLineDriverHireCost; secondLineHasDriver = true; }
    }
    clampedMoney = Math.Min(clampedMoney, progressionBudget);

    var stopsWaitingJson = System.Text.Json.JsonSerializer.Serialize(
        request.StopsWaiting.Select(waiting => Math.Clamp(waiting, 0m, EconomyConstants.MaxStopWaiting)).ToList()
    );

    var checkpointPurchasedFromSnapshot = !existing.HasCheckpoint && request.HasCheckpoint;
    if (checkpointPurchasedFromSnapshot)
    {
        if (progressionBudget < EconomyConstants.CheckpointCost)
        {
            return Results.BadRequest(new { message = $"Denetim noktasi icin en az {EconomyConstants.CheckpointCost:N0} TL lazim." });
        }

        existing.HasCheckpoint = true;
        progressionBudget -= EconomyConstants.CheckpointCost;
        clampedMoney = Math.Min(clampedMoney, progressionBudget);
    }

    // Terminal yukseltmeleri: yalnizca gecerli id'ler, maliyet sunucuda onceki
    // bakiyeden tahsil edilir (checkpoint kalibi), liste kucultulemez. Bu blok
    // existing.Money atamasindan ONCE calismali ki kesinti kaydedilsin.
    var ownedTerminalUpgrades = System.Text.Json.JsonSerializer.Deserialize<List<string>>(existing.TerminalUpgradesJson) ?? [];
    var terminalBudget = progressionBudget;
    foreach (var upgradeId in (request.TerminalUpgrades ?? []).Distinct())
    {
        if (ownedTerminalUpgrades.Contains(upgradeId)) continue;
        if (!CanUse("terminal")) { clamped = true; continue; }
        if (!EconomyConstants.TerminalUpgradeCosts.TryGetValue(upgradeId, out var upgradeCost)) continue;
        if (terminalBudget < upgradeCost) { clamped = true; continue; }
        terminalBudget -= upgradeCost;
        clampedMoney = Math.Min(clampedMoney, terminalBudget);
        ownedTerminalUpgrades.Add(upgradeId);
    }
    existing.TerminalUpgradesJson = System.Text.Json.JsonSerializer.Serialize(ownedTerminalUpgrades);

    // Hat kilidi: gecerli id + maliyet sunucuda onceki bakiyeden tahsil, liste kucultulemez.
    var unlockedRoutes = System.Text.Json.JsonSerializer.Deserialize<List<string>>(existing.UnlockedRoutesJson)
        ?? ["starter-center"];
    var routeBudget = terminalBudget;
    foreach (var routeId in (request.UnlockedRoutes ?? []).Distinct())
    {
        if (unlockedRoutes.Contains(routeId)) continue;
        if (!CanUse("routes")) { clamped = true; continue; }
        if (!EconomyConstants.RouteUnlockCosts.TryGetValue(routeId, out var routeCost)) continue;
        if (routeBudget < routeCost) { clamped = true; continue; }
        routeBudget -= routeCost;
        clampedMoney = Math.Min(clampedMoney, routeBudget);
        unlockedRoutes.Add(routeId);
    }
    existing.UnlockedRoutesJson = System.Text.Json.JsonSerializer.Serialize(unlockedRoutes);
    // Aktif hat yalnizca ACILMIS hatlardan biri olabilir.
    if (!string.IsNullOrWhiteSpace(request.ActiveRouteId) && unlockedRoutes.Contains(request.ActiveRouteId))
    {
        existing.ActiveRouteId = request.ActiveRouteId;
    }
    else if (!unlockedRoutes.Contains(existing.ActiveRouteId))
    {
        existing.ActiveRouteId = "starter-center";
    }

    // Garaj araci: hat kilidiyle ayni kalip — maliyet sunucuda tahsil, liste kucultulemez.
    var ownedBusIds = System.Text.Json.JsonSerializer.Deserialize<List<string>>(existing.OwnedBusIdsJson)
        ?? ["hurda-mavi"];
    var busBudget = routeBudget;
    foreach (var busId in (request.OwnedBusIds ?? []).Distinct())
    {
        if (ownedBusIds.Contains(busId)) continue;
        if (busId == "midibus" && !CanUse("midibus")) { clamped = true; continue; }
        if (busId == "premium" && !CanUse("premium")) { clamped = true; continue; }
        if (!EconomyConstants.BusCatalogPrices.TryGetValue(busId, out var busPrice)) continue;
        if (busBudget < busPrice) { clamped = true; continue; }
        busBudget -= busPrice;
        clampedMoney = Math.Min(clampedMoney, busBudget);
        ownedBusIds.Add(busId);
    }
    existing.OwnedBusIdsJson = System.Text.Json.JsonSerializer.Serialize(ownedBusIds);
    if (!string.IsNullOrWhiteSpace(request.ActiveBusId) && ownedBusIds.Contains(request.ActiveBusId))
    {
        existing.ActiveBusId = request.ActiveBusId;
    }
    else if (!ownedBusIds.Contains(existing.ActiveBusId))
    {
        existing.ActiveBusId = ownedBusIds[0];
    }
    savedBusUpgrades[existing.ActiveBusId] = new UpgradesDto(motorLevel, seatLevel, soundLevel, hasCashRegister);
    existing.BusUpgradesJson = System.Text.Json.JsonSerializer.Serialize(
        savedBusUpgrades.Where(pair => ownedBusIds.Contains(pair.Key)).ToDictionary(pair => pair.Key, pair => pair.Value)
    );

    // Eski istemciler SaveVersion=0/1 gonderebilir; sunucu kaydi her zaman guncel semaya yukseltir.
    existing.SaveVersion = SchemaVersions.CurrentGameSave;
    existing.Money = clampedMoney;
    existing.Satisfaction = Math.Clamp(request.Satisfaction, 0, 100);
    existing.StopsWaitingJson = stopsWaitingJson;
    existing.SeatCapacity = EconomyConstants.SeatCapacityForLevel(seatLevel);
    existing.MotorLevel = motorLevel;
    existing.SeatLevel = seatLevel;
    existing.SoundLevel = soundLevel;
    // Yolcu sayisi istemciden gelir ama sunucunun hesapladigi koltuk kapasitesiyle sinirlanir
    // (bkz. ADR-006 server-owned state) — request.SeatCapacity'ye guvenilmez.
    existing.PassengersOnBoard = Math.Clamp(request.PassengersOnBoard, 0, existing.SeatCapacity + 1);
    existing.NextStopDropoffs = Math.Clamp(request.NextStopDropoffs, 0, existing.PassengersOnBoard);
    existing.HasCashRegister = hasCashRegister;
    existing.HiredDriverId = hiredDriverId;
    existing.OwnedBusesJson = System.Text.Json.JsonSerializer.Serialize(request.OwnedBuses ?? []);
    existing.DriverAssignmentsJson = System.Text.Json.JsonSerializer.Serialize(request.DriverAssignments ?? new Dictionary<string, Dictionary<string, string?>>());
    existing.DriverShiftMinutesJson = System.Text.Json.JsonSerializer.Serialize(request.DriverShiftMinutes ?? new Dictionary<string, decimal>());
    existing.DriverMoraleJson = System.Text.Json.JsonSerializer.Serialize(request.DriverMorale ?? new Dictionary<string, decimal>());
    existing.RouteMasteryJson = System.Text.Json.JsonSerializer.Serialize(request.RouteMastery ?? new Dictionary<string, RouteMasteryEntryDto>());
    existing.TutorialStatusJson = System.Text.Json.JsonSerializer.Serialize(request.TutorialStatus ?? new Dictionary<string, string>());
    existing.GameTimeMinutes = Math.Clamp(request.GameTimeMinutes ?? existing.GameTimeMinutes, 0, 1439.999m);
    existing.GameDay = Math.Max(1, request.GameDay ?? existing.GameDay);
    existing.LicencePoints = Math.Clamp(request.LicencePoints ?? existing.LicencePoints, 0, EconomyConstants.Licence.MaxPoints - 1);
    existing.PoliceRisk = Math.Clamp(request.PoliceRisk ?? existing.PoliceRisk, 0m, 100m);
    existing.ShortChangeStreak = Math.Clamp(request.ShortChangeStreak ?? existing.ShortChangeStreak, 0, Math.Max(0, EconomyConstants.Licence.ShortChange.Count - 1));
    existing.VehicleLockSecondsLeft = Math.Clamp(request.VehicleLockSecondsLeft ?? existing.VehicleLockSecondsLeft, 0m, EconomyConstants.Licence.SuspensionSeconds);
    // ChanceGamesJson bilerek burada yazilmaz: sans oyunu bakiyesi backend otoritelidir
    // ve yalnizca kendi uc noktalarindan ledger'a islenir (bkz. ADR-005).
    existing.SecondLineUnlocked = secondLineUnlocked;
    existing.SecondLineHasDriver = secondLineHasDriver;
    existing.SavedAtUtc = now;

    await db.SaveChangesAsync();

    return Results.Ok(ToResponse(existing, clamped, offlineIncome: 0m));
})
.WithName("UpsertGameSave");

// ---- Oyunu sifirla ----
// Hesap (kullanici adi + sifre) korunur; ilerlemenin TAMAMI silinir: kayit, sirket,
// level/XP, basarimlar, kontrat/vardiya kayitlari ve sans oyunu gecmisi.
// Yikici bir islem oldugu icin yalniz token dogrulanmis oyuncunun kendisi cagirabilir.
app.MapPost("/api/saves/{playerId}/reset", async (string playerId, FullFilledDbContext db, HttpContext httpContext) =>
{
    var auth = await FindAuthorizedSave(playerId, db, httpContext);
    if (auth.Result is not null) return auth.Result;
    var save = auth.Save!;

    await using var transaction = await db.Database.BeginTransactionAsync();

    // Oyuncuya bagli tum ilerleme kayitlari silinir.
    db.Companies.RemoveRange(db.Companies.Where(c => c.PlayerId == playerId));
    db.PlayerProgression.RemoveRange(db.PlayerProgression.Where(p => p.PlayerId == playerId));
    db.PlayerAchievements.RemoveRange(db.PlayerAchievements.Where(a => a.PlayerId == playerId));
    db.ContractRuns.RemoveRange(db.ContractRuns.Where(c => c.PlayerId == playerId));
    db.ShiftResults.RemoveRange(db.ShiftResults.Where(s => s.PlayerId == playerId));
    db.ChanceGameTransactions.RemoveRange(db.ChanceGameTransactions.Where(c => c.PlayerId == playerId));
    // Olay defteri de silinmeli: idempotency anahtarlari oyuncu OMRU boyunca tekildir
    // ($"company_created:{playerId}" gibi). Kalirlarsa sifirlamadan sonra sirket kurma
    // UNIQUE kisitina takilip 500 doner.
    db.GameplayEvents.RemoveRange(db.GameplayEvents.Where(e => e.PlayerId == playerId));
    db.GameSessions.RemoveRange(db.GameSessions.Where(s => s.PlayerId == playerId));
    db.TelemetryEvents.RemoveRange(db.TelemetryEvents.Where(e => e.PlayerId == playerId));

    // Kayit satiri silinmez (kullanici adi/sifre orada) — baslangic degerlerine dondurulur.
    save.SaveVersion = SchemaVersions.CurrentGameSave;
    save.Money = 0m;
    save.Satisfaction = EconomyConstants.InitialSatisfaction;
    save.StopsWaitingJson = "[]";
    save.PassengersOnBoard = 0;
    save.NextStopDropoffs = 0;
    save.SeatCapacity = EconomyConstants.BaseSeatCapacity;
    save.MotorLevel = 0;
    save.SeatLevel = 0;
    save.SoundLevel = 0;
    save.HasCashRegister = false;
    save.BusUpgradesJson = "{}";
    save.HiredDriverId = null;
    save.OwnedBusesJson = "[]";
    save.DriverAssignmentsJson = "{}";
    save.DriverShiftMinutesJson = "{}";
    save.DriverMoraleJson = "{}";
    save.RouteMasteryJson = "{}";
    save.TutorialStatusJson = "{}";
    save.ChanceGamesJson = "{}";
    save.GameTimeMinutes = 480m;
    save.GameDay = 1;
    save.LicencePoints = 0;
    save.PoliceRisk = 0m;
    save.ShortChangeStreak = 0;
    save.VehicleLockSecondsLeft = 0m;
    save.TerminalUpgradesJson = "[]";
    save.UnlockedRoutesJson = "[\"starter-center\"]";
    save.ActiveRouteId = "starter-center";
    save.OwnedBusIdsJson = "[\"hurda-mavi\"]";
    save.ActiveBusId = "hurda-mavi";
    save.SecondLineUnlocked = false;
    save.SecondLineHasDriver = false;
    save.HasCheckpoint = false;
    save.SavedAtUtc = DateTime.UtcNow;

    await db.SaveChangesAsync();
    // Sirket kurma akisi yeniden calissin diye temel kayitlar yeni hesap gibi kurulur.
    await EnsurePlayerFoundationAsync(save, db, isNewAccount: true);
    db.GameplayEvents.Add(new GameplayEvent
    {
        PlayerId = playerId,
        IdempotencyKey = $"game-reset:{Guid.NewGuid():N}",
        Type = "game_reset",
        Category = "operation",
        DataJson = "{}",
        ClientBuild = "server",
        DeviceClass = "unknown",
        Locale = "tr",
        PlayerLevel = 1,
        ClientAtUtc = save.SavedAtUtc,
        CreatedAtUtc = save.SavedAtUtc,
    });
    await db.SaveChangesAsync();
    await transaction.CommitAsync();

    return Results.Ok(new { ok = true });
})
.WithName("ResetGame");

app.MapPost("/api/saves/{playerId}/checkpoint", async (string playerId, FullFilledDbContext db, HttpContext httpContext) =>
{
    var auth = await FindAuthorizedSave(playerId, db, httpContext);
    if (auth.Result is not null) return auth.Result;
    var save = auth.Save!;

    if (save.HasCheckpoint)
    {
        return Results.Ok(new BuyCheckpointResponse(save.Money, true, "Denetim noktasi zaten kurulu."));
    }

    if (save.Money < EconomyConstants.CheckpointCost)
    {
        return Results.BadRequest(new { message = $"Denetim noktasi icin en az {EconomyConstants.CheckpointCost:N0} TL lazim." });
    }

    save.Money -= EconomyConstants.CheckpointCost;
    save.HasCheckpoint = true;
    save.SavedAtUtc = DateTime.UtcNow;
    await db.SaveChangesAsync();

    return Results.Ok(new BuyCheckpointResponse(save.Money, true, "Denetim noktasi kuruldu."));
})
.WithName("BuyCheckpoint");

// ---- Sans oyunlari: ilk MVP Mahalle Carki ----
// Sonuc sunucuda uretilir; istemci sadece guncel parayi ve cark gunluk state'ini uygular.

app.MapPost("/api/chance/wheel/spin/{playerId}", async (string playerId, SpinWheelRequest request, FullFilledDbContext db, ProgressionService service, HttpContext httpContext) =>
{
    var auth = await FindAuthorizedSave(playerId, db, httpContext);
    if (auth.Result is not null) return auth.Result;
    return await ChanceGameService.SpinWheelAsync(playerId, request, db, service);
})
.WithName("SpinWheel");





// ---- Aşama 5: link=şehir, misafir yolcu, korsan sefer ----
// bkz. docs/game-design/06-sosyal-link-sekme.md + ADR-003 (asenkron multiplayer).
// Not: kullanıcı adı artık /api/auth/login'de hesap açılışında belirleniyor — ayrı bir
// "claim" uç noktasına gerek kalmadı (şifresiz claim güvenlik açığıydı, kaldırıldı).

app.MapGet("/api/cities/{username}", async (string username, FullFilledDbContext db) =>
{
    var normalized = username.Trim().ToLowerInvariant();
    var save = await db.GameSaves.FirstOrDefaultAsync(s => s.Username == normalized);
    if (save is null) return Results.NotFound();

    // Firma ve ilerleme ayri tablolarda tutulur; ikisi de eksik olabilir (eski kayitlar),
    // bu yuzden null-safe okunup varsayilanlara dusulur.
    var company = await db.Companies.FirstOrDefaultAsync(c => c.PlayerId == save.PlayerId);
    var progression = await db.PlayerProgression.FirstOrDefaultAsync(p => p.PlayerId == save.PlayerId);

    return Results.Ok(new CityPublicDto(
        save.Username!,
        save.Money,
        save.Satisfaction,
        !string.IsNullOrEmpty(save.HiredDriverId),
        save.HasCheckpoint,
        save.SavedAtUtc,
        company?.Name,
        company?.EmblemId,
        company?.PrimaryColor,
        progression?.Level ?? 1,
        progression?.Experience ?? 0
    ));
})
.WithName("GetCityPublic");

// ---- Arkadas listesi ----
// Tek yonlu: liste sahibi istedigi sehri ekler, karsi tarafin onayi aranmaz (ADR-003 asenkron sosyal).
// Uc noktalar yalnizca cagiranin KENDI listesine erisir; yetki FindAuthorizedSave ile dogrulanir.

app.MapGet("/api/friends/{playerId}", async (string playerId, FullFilledDbContext db, HttpContext httpContext) =>
{
    var auth = await FindAuthorizedSave(playerId, db, httpContext);
    if (auth.Result is not null) return auth.Result;

    var friendPlayerIds = await db.Friendships
        .Where(f => f.PlayerId == playerId)
        .Select(f => f.FriendPlayerId)
        .ToListAsync();
    if (friendPlayerIds.Count == 0) return Results.Ok(Array.Empty<FriendDto>());

    // Tek seferde toplu okuma — arkadas basina sorgu acmak N+1 olurdu.
    var saves = await db.GameSaves
        .Where(s => friendPlayerIds.Contains(s.PlayerId))
        .ToListAsync();
    var companies = await db.Companies
        .Where(c => friendPlayerIds.Contains(c.PlayerId))
        .ToDictionaryAsync(c => c.PlayerId);
    var progressions = await db.PlayerProgression
        .Where(p => friendPlayerIds.Contains(p.PlayerId))
        .ToDictionaryAsync(p => p.PlayerId);

    var friends = saves
        .Select(save => ToFriendDto(
            save,
            companies.GetValueOrDefault(save.PlayerId),
            progressions.GetValueOrDefault(save.PlayerId)))
        .OrderByDescending(friend => friend.Level)
        .ThenBy(friend => friend.Username, StringComparer.Ordinal)
        .ToList();

    return Results.Ok(friends);
})
.WithName("GetFriends");

app.MapPost("/api/friends/{playerId}", async (string playerId, AddFriendRequest request, FullFilledDbContext db, HttpContext httpContext) =>
{
    var auth = await FindAuthorizedSave(playerId, db, httpContext);
    if (auth.Result is not null) return auth.Result;

    // Kullanici adi kayitta kucuk harfe normalize edilerek tutulur (bkz. /api/auth/login).
    var normalized = (request.Username ?? string.Empty).Trim().ToLowerInvariant();
    if (normalized.Length == 0) return Results.NotFound();

    var target = await db.GameSaves.FirstOrDefaultAsync(s => s.Username == normalized);
    if (target is null) return Results.NotFound();
    if (target.PlayerId == playerId)
        return Results.BadRequest(new { message = "Kendini arkadas olarak ekleyemezsin." });

    var alreadyExists = await db.Friendships
        .AnyAsync(f => f.PlayerId == playerId && f.FriendPlayerId == target.PlayerId);
    if (alreadyExists)
        return Results.Json(new { message = "Bu sehir zaten arkadas listende." }, statusCode: 409);

    db.Friendships.Add(new Friendship
    {
        PlayerId = playerId,
        FriendPlayerId = target.PlayerId,
        CreatedAtUtc = DateTime.UtcNow,
    });
    await db.SaveChangesAsync();

    var company = await db.Companies.FirstOrDefaultAsync(c => c.PlayerId == target.PlayerId);
    var progression = await db.PlayerProgression.FirstOrDefaultAsync(p => p.PlayerId == target.PlayerId);
    return Results.Ok(ToFriendDto(target, company, progression));
})
.WithName("AddFriend");

app.MapDelete("/api/friends/{playerId}/{username}", async (string playerId, string username, FullFilledDbContext db, HttpContext httpContext) =>
{
    var auth = await FindAuthorizedSave(playerId, db, httpContext);
    if (auth.Result is not null) return auth.Result;

    var normalized = (username ?? string.Empty).Trim().ToLowerInvariant();
    if (normalized.Length == 0) return Results.NotFound();

    var target = await db.GameSaves.FirstOrDefaultAsync(s => s.Username == normalized);
    if (target is null) return Results.NotFound();

    var friendship = await db.Friendships
        .FirstOrDefaultAsync(f => f.PlayerId == playerId && f.FriendPlayerId == target.PlayerId);
    if (friendship is null) return Results.NotFound();

    db.Friendships.Remove(friendship);
    await db.SaveChangesAsync();
    return Results.NoContent();
})
.WithName("RemoveFriend");

app.MapPost("/api/cities/{username}/tip", async (string username, VisitorRequest request, FullFilledDbContext db, HttpContext httpContext) =>
{
    var actorAuth = await FindAuthorizedSave(request.ActorPlayerId, db, httpContext);
    if (actorAuth.Result is not null) return actorAuth.Result;

    var normalized = username.Trim().ToLowerInvariant();
    var host = await db.GameSaves.FirstOrDefaultAsync(s => s.Username == normalized);
    if (host is null) return Results.NotFound();
    if (host.PlayerId == request.ActorPlayerId)
        return Results.BadRequest(new TipResultDto(false, 0, "social.tip.self"));

    // Bedava para üretimini önlemek için bahşiş de korsan seferle aynı günlük limite tabi.
    var todayStartUtc = DateTime.UtcNow.Date;
    var todaysTipCount = await db.CityEvents.CountAsync(e =>
        e.HostPlayerId == host.PlayerId &&
        e.ActorPlayerId == request.ActorPlayerId &&
        e.Type == "tip" &&
        e.CreatedAtUtc >= todayStartUtc);
    if (todaysTipCount >= EconomyConstants.RaidDailyLimitPerHost)
    {
        return Results.Ok(new TipResultDto(false, 0, "social.tip.limit"));
    }

    var amount = EconomyConstants.TipMin + (decimal)Random.Shared.NextDouble() * (EconomyConstants.TipMax - EconomyConstants.TipMin);
    amount = Math.Round(amount, 2);
    host.Money += amount;

    db.CityEvents.Add(new CityEvent
    {
        HostPlayerId = host.PlayerId,
        ActorPlayerId = request.ActorPlayerId,
        ActorUsername = request.ActorUsername,
        Type = "tip",
        Amount = amount,
        CreatedAtUtc = DateTime.UtcNow,
    });
    await db.SaveChangesAsync();

    return Results.Ok(new TipResultDto(true, amount, "social.tip.success"));
})
.WithName("TipCity");

app.MapPost("/api/cities/{username}/raid", async (string username, VisitorRequest request, FullFilledDbContext db, HttpContext httpContext) =>
{
    var actorAuth = await FindAuthorizedSave(request.ActorPlayerId, db, httpContext);
    if (actorAuth.Result is not null) return actorAuth.Result;

    var normalized = username.Trim().ToLowerInvariant();
    var host = await db.GameSaves.FirstOrDefaultAsync(s => s.Username == normalized);
    if (host is null) return Results.NotFound();
    if (host.PlayerId == request.ActorPlayerId)
        return Results.BadRequest(new RaidResultDto(false, false, 0, "social.raid.self"));

    var todayStartUtc = DateTime.UtcNow.Date;
    var todaysRaidCount = await db.CityEvents.CountAsync(e =>
        e.HostPlayerId == host.PlayerId &&
        e.ActorPlayerId == request.ActorPlayerId &&
        (e.Type == "raid" || e.Type == "raid-caught") &&
        e.CreatedAtUtc >= todayStartUtc);

    if (todaysRaidCount >= EconomyConstants.RaidDailyLimitPerHost)
    {
        return Results.Ok(new RaidResultDto(false, false, 0, "social.raid.limit"));
    }

    var stolen = Math.Min(host.Money * EconomyConstants.RaidStealPercent, EconomyConstants.RaidStealCap);
    stolen = Math.Round(Math.Max(stolen, 0), 2);

    var caught = host.HasCheckpoint && Random.Shared.NextDouble() < (double)EconomyConstants.RaidCatchChanceWithCheckpoint;

    var actor = actorAuth.Save;
    string messageKey;

    if (caught)
    {
        var penalty = stolen * 2;
        if (actor is not null)
        {
            actor.Money -= penalty;
            host.Money += penalty;
        }
        db.CityEvents.Add(new CityEvent
        {
            HostPlayerId = host.PlayerId,
            ActorPlayerId = request.ActorPlayerId,
            ActorUsername = request.ActorUsername,
            Type = "raid-caught",
            Amount = penalty,
            CreatedAtUtc = DateTime.UtcNow,
        });
        messageKey = "social.raid.caught";
    }
    else
    {
        host.Money -= stolen;
        if (actor is not null) actor.Money += stolen;
        db.CityEvents.Add(new CityEvent
        {
            HostPlayerId = host.PlayerId,
            ActorPlayerId = request.ActorPlayerId,
            ActorUsername = request.ActorUsername,
            Type = "raid",
            Amount = stolen,
            CreatedAtUtc = DateTime.UtcNow,
        });
        messageKey = "social.raid.success";
    }

    await db.SaveChangesAsync();
    return Results.Ok(new RaidResultDto(!caught, caught, caught ? 0 : stolen, messageKey));
})
.WithName("RaidCity");

app.MapGet("/api/cities/{username}/events", async (string username, FullFilledDbContext db) =>
{
    var normalized = username.Trim().ToLowerInvariant();
    var host = await db.GameSaves.FirstOrDefaultAsync(s => s.Username == normalized);
    if (host is null) return Results.NotFound();

    var events = await db.CityEvents
        .Where(e => e.HostPlayerId == host.PlayerId)
        .OrderByDescending(e => e.CreatedAtUtc)
        .Take(20)
        .Select(e => new CityEventDto(e.Type, e.ActorUsername, e.Amount, e.CreatedAtUtc))
        .ToListAsync();

    return Results.Ok(events);
})
.WithName("GetCityEvents");

// ---- Telemetri + geri bildirim (monitoring) ----
// Istemci 20 sn'de bir toplu gonderir. Kotuye kullanimi sinirlamak icin istek basina
// olay tavani ve alan uzunluk tavanlari uygulanir; asanlar sessizce kirpilir.

const int MaxFeedbackMessageLength = 4000;

app.MapPost("/api/telemetry/{playerId}", async (
    string playerId,
    TelemetryBatchRequest request,
    FullFilledDbContext db,
    TelemetryIngestionService telemetry,
    HttpContext httpContext) =>
{
    var (save, authResult) = await FindAuthorizedSave(playerId, db, httpContext);
    if (save is null) return authResult!;
    return Results.Ok(await telemetry.IngestAsync(save, request, httpContext.RequestAborted));
})
.WithName("PostTelemetry");

app.MapPost("/api/feedback/{playerId}", async (
    string playerId,
    FeedbackRequest request,
    FullFilledDbContext db,
    HttpContext httpContext) =>
{
    var (save, authResult) = await FindAuthorizedSave(playerId, db, httpContext);
    if (save is null) return authResult!;

    var message = (request.Message ?? string.Empty).Trim();
    if (message.Length < 3)
    {
        return Results.BadRequest(new { message = "Geri bildirim cok kisa." });
    }

    var category = request.Category is "bug" or "idea" or "balance" ? request.Category : "bug";

    db.FeedbackEntries.Add(new FeedbackEntry
    {
        PlayerId = save.PlayerId,
        Username = save.Username,
        Category = category,
        Message = message.Length > MaxFeedbackMessageLength ? message[..MaxFeedbackMessageLength] : message,
        ContextJson = string.IsNullOrWhiteSpace(request.ContextJson) ? "{}" : request.ContextJson,
        CreatedAtUtc = DateTime.UtcNow,
    });
    await db.SaveChangesAsync();

    return Results.Ok(new { ok = true });
})
.WithName("PostFeedback");

// Admin uçlarının tamamı env'de tanımlı tek hesabın veritabanındaki aktif oturumuyla korunur.
app.MapGet("/api/admin/access", async (FullFilledDbContext db, IConfiguration config, HttpContext httpContext) =>
{
    if (!await AdminAccess.IsAuthorizedAsync(httpContext, config, db, httpContext.RequestAborted))
    {
        return Results.Json(new { message = "Yetkisiz." }, statusCode: 401);
    }

    return Results.Ok(new { authorized = true });
})
.WithName("GetAdminAccess");

app.MapGet("/api/admin/feedback", async (FullFilledDbContext db, IConfiguration config, HttpContext httpContext) =>
{
    if (!await AdminAccess.IsAuthorizedAsync(httpContext, config, db, httpContext.RequestAborted))
    {
        return Results.Json(new { message = "Yetkisiz." }, statusCode: 401);
    }

    var entries = await db.FeedbackEntries
        .OrderByDescending(e => e.CreatedAtUtc)
        .Take(200)
        .Select(e => new FeedbackEntryDto(
            e.Id, e.PlayerId, e.Username, e.Category, e.Message, e.ContextJson, e.CreatedAtUtc))
        .ToListAsync(httpContext.RequestAborted);

    return Results.Ok(entries);
})
.WithName("GetAdminFeedback");

app.MapAnalyticsEndpoints();
app.MapProgressionEndpoints();
app.MapContractEndpoints();
app.MapEventEndpoints();

app.Run();

static async Task EnsurePlayerFoundationAsync(GameSave save, FullFilledDbContext db, bool isNewAccount)
{
    var now = DateTime.UtcNow;
    if (!await db.PlayerProgression.AnyAsync(item => item.PlayerId == save.PlayerId))
    {
        db.PlayerProgression.Add(new PlayerProgression
        {
            PlayerId = save.PlayerId,
            Level = 1,
            Experience = 0,
            CreatedAtUtc = now,
            UpdatedAtUtc = now,
        });
    }

    if (isNewAccount && !await db.GameplayEvents.AnyAsync(item =>
        item.PlayerId == save.PlayerId && item.IdempotencyKey == $"account_created:{save.PlayerId}"))
    {
        db.GameplayEvents.Add(new GameplayEvent
        {
            PlayerId = save.PlayerId,
            IdempotencyKey = $"account_created:{save.PlayerId}",
            Type = "account_created",
            Category = "funnel",
            DataJson = "{}",
            ClientBuild = "server",
            DeviceClass = "unknown",
            Locale = "tr",
            PlayerLevel = 1,
            ClientAtUtc = now,
            CreatedAtUtc = now,
        });
    }
}

// Arkadas karti: kimlik GameSaves'ten, firma gorseli Companies'ten, seviye PlayerProgression'dan
// birlestirilir. Eksik kayitlarda null/varsayilan doner (CityPublicDto ile ayni kural).
static FriendDto ToFriendDto(GameSave save, Company? company, PlayerProgression? progression) => new(
    save.Username ?? string.Empty,
    company?.Name,
    company?.EmblemId,
    company?.PrimaryColor,
    progression?.Level ?? 1,
    save.Satisfaction,
    save.SavedAtUtc
);

static bool HasDriverAssignments(string? assignmentsJson)
{
    if (string.IsNullOrWhiteSpace(assignmentsJson) || assignmentsJson == "{}") return false;
    try
    {
        var assignments = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string?>>>(assignmentsJson);
        return assignments?.Values.Any(shifts => shifts.Values.Any(driverId => !string.IsNullOrWhiteSpace(driverId))) == true;
    }
    catch
    {
        return false;
    }
}

static bool IsProgressionUnlockAvailable(string unlockId, int level, IReadOnlySet<string> achievements)
{
    if (!EconomyConstants.Progression.Unlocks.TryGetValue(unlockId, out var rule)) return true;
    return level >= rule.Level && rule.Milestones.All(achievements.Contains);
}

static decimal CalculateOfflineShiftIncome(GameSave save, double cappedSeconds)
{
    if (cappedSeconds <= 0) return 0m;

    var assignments = ParseJson(save.DriverAssignmentsJson, new Dictionary<string, Dictionary<string, string?>>());
    if (!string.IsNullOrWhiteSpace(save.HiredDriverId))
    {
        if (!assignments.TryGetValue("main", out var mainAssignments))
        {
            mainAssignments = new Dictionary<string, string?>();
            assignments["main"] = mainAssignments;
        }
        mainAssignments.TryAdd("morning", save.HiredDriverId);
    }

    var ownedBuses = ParseJson(save.OwnedBusesJson, new List<OwnedBusDto>());
    var busIds = new List<string> { "main" };
    busIds.AddRange(ownedBuses.Select(bus => bus.Id));

    var driversById = EconomyConstants.Drivers.ToDictionary(driver => driver.Id);
    var remainingSeconds = (decimal)cappedSeconds;
    var cursorGameMinutes = NormalizeGameMinute(save.GameTimeMinutes);
    var totalIncome = 0m;

    while (remainingSeconds > 0)
    {
        var activeShift = ActiveShiftId(cursorGameMinutes);
        var secondsUntilShiftChange = SecondsUntilShiftChange(cursorGameMinutes);
        var chunkSeconds = Math.Min(remainingSeconds, secondsUntilShiftChange);

        foreach (var busId in busIds)
        {
            var driverId = assignments.TryGetValue(busId, out var shiftAssignments)
                ? shiftAssignments.GetValueOrDefault(activeShift)
                : null;
            if (string.IsNullOrWhiteSpace(driverId)) continue;
            if (!driversById.TryGetValue(driverId, out var driver)) continue;

            totalIncome += NetShiftIncomePerSecond(busId, activeShift, driver) * chunkSeconds;
        }

        remainingSeconds -= chunkSeconds;
        cursorGameMinutes = NormalizeGameMinute(cursorGameMinutes + chunkSeconds * EconomyConstants.GameMinutesPerRealSecond);
    }

    return Math.Round(Math.Max(0, totalIncome), 2);
}

static T ParseJson<T>(string? json, T fallback)
{
    if (string.IsNullOrWhiteSpace(json)) return fallback;
    try
    {
        return System.Text.Json.JsonSerializer.Deserialize<T>(json) ?? fallback;
    }
    catch
    {
        return fallback;
    }
}

static string ActiveShiftId(decimal gameTimeMinutes)
{
    var hour = (int)Math.Floor(NormalizeGameMinute(gameTimeMinutes) / 60m);
    if (hour >= 8 && hour < 16) return "morning";
    if (hour >= 16) return "evening";
    return "night";
}

static decimal SecondsUntilShiftChange(decimal gameTimeMinutes)
{
    var normalized = NormalizeGameMinute(gameTimeMinutes);
    var nextBoundary = normalized switch
    {
        < 480m => 480m,
        < 960m => 960m,
        _ => 1440m,
    };
    return Math.Max(1m, (nextBoundary - normalized) / EconomyConstants.GameMinutesPerRealSecond);
}

static decimal NormalizeGameMinute(decimal gameTimeMinutes)
{
    var normalized = gameTimeMinutes % 1440m;
    return normalized < 0 ? normalized + 1440m : normalized;
}

static decimal NetShiftIncomePerSecond(string busId, string shiftId, DriverConfig driver)
{
    const decimal shiftCountPerDay = 3m;
    var realSecondsPerGameDay = 1440m / EconomyConstants.GameMinutesPerRealSecond;
    var shiftRealSeconds = realSecondsPerGameDay / shiftCountPerDay;
    var grossPerDay = busId == "main"
        ? EconomyConstants.MainBusDailyGrossIncome
        : EconomyConstants.ExtraBusDailyGrossIncome;
    var shiftMultiplier = shiftId == "night" ? EconomyConstants.NightShiftIncomeMultiplier : 1m;
    var grossPerShift = grossPerDay / shiftCountPerDay * shiftMultiplier;
    var netPerShift = grossPerShift * driver.Efficiency - driver.DailySalary;
    return Math.Max(0, netPerShift / shiftRealSeconds);
}

static ChanceGamesDto NewChanceGamesState(int day) => new(day, 0m, 0, []);

static ChanceGamesDto ParseChanceGames(string? chanceGamesJson)
{
    if (string.IsNullOrWhiteSpace(chanceGamesJson) || chanceGamesJson == "{}") return NewChanceGamesState(day: 1);
    try
    {
        return System.Text.Json.JsonSerializer.Deserialize<ChanceGamesDto>(chanceGamesJson) ?? NewChanceGamesState(day: 1);
    }
    catch
    {
        return NewChanceGamesState(day: 1);
    }
}

static async Task<(GameSave? Save, IResult? Result)> FindAuthorizedSave(string playerId, FullFilledDbContext db, HttpContext httpContext)
{
    var save = await db.GameSaves.FindAsync(playerId);
    if (save is null) return (null, Results.NotFound());

    var token = ReadAuthToken(httpContext);
    if (string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(save.AuthTokenHash))
    {
        return (null, Results.Json(new { message = "Oturum token'i eksik. Tekrar giris yap." }, statusCode: 401));
    }

    if (!PasswordHasher.Verify(token, save.AuthTokenHash))
    {
        return (null, Results.Json(new { message = "Oturum token'i gecersiz. Tekrar giris yap." }, statusCode: 401));
    }

    return (save, null);
}

static string? ReadAuthToken(HttpContext httpContext)
{
    if (httpContext.Request.Headers.TryGetValue("X-FullFilled-Auth", out var headerToken))
    {
        return headerToken.ToString();
    }

    if (httpContext.Request.Headers.Authorization.ToString() is { Length: > 7 } authorization &&
        authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
    {
        return authorization["Bearer ".Length..].Trim();
    }

    return null;
}

static string CreateAuthToken()
{
    var bytes = RandomNumberGenerator.GetBytes(32);
    return Convert.ToBase64String(bytes)
        .Replace("+", "-", StringComparison.Ordinal)
        .Replace("/", "_", StringComparison.Ordinal)
        .TrimEnd('=');
}

static SaveGameResponse ToResponse(GameSave save, bool clamped, decimal offlineIncome) => new(
    save.Money,
    save.Satisfaction,
    System.Text.Json.JsonSerializer.Deserialize<List<decimal>>(save.StopsWaitingJson) ?? [],
    save.PassengersOnBoard,
    save.NextStopDropoffs,
    save.SeatCapacity,
    new UpgradesDto(save.MotorLevel, save.SeatLevel, save.SoundLevel, save.HasCashRegister),
    System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, UpgradesDto>>(save.BusUpgradesJson) ?? new Dictionary<string, UpgradesDto>(),
    save.HiredDriverId,
    new SecondLineDto(save.SecondLineUnlocked, save.SecondLineHasDriver),
    save.HasCheckpoint,
    System.Text.Json.JsonSerializer.Deserialize<List<OwnedBusDto>>(save.OwnedBusesJson) ?? [],
    System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string?>>>(save.DriverAssignmentsJson) ?? new Dictionary<string, Dictionary<string, string?>>(),
    System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, decimal>>(save.DriverShiftMinutesJson) ?? new Dictionary<string, decimal>(),
    System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, decimal>>(save.DriverMoraleJson) ?? new Dictionary<string, decimal>(),
    System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, RouteMasteryEntryDto>>(save.RouteMasteryJson) ?? new Dictionary<string, RouteMasteryEntryDto>(),
    System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(save.TutorialStatusJson) ?? new Dictionary<string, string>(),
    ParseChanceGames(save.ChanceGamesJson),
    System.Text.Json.JsonSerializer.Deserialize<List<string>>(save.TerminalUpgradesJson) ?? [],
    System.Text.Json.JsonSerializer.Deserialize<List<string>>(save.UnlockedRoutesJson) ?? ["starter-center"],
    save.ActiveRouteId,
    System.Text.Json.JsonSerializer.Deserialize<List<string>>(save.OwnedBusIdsJson) ?? ["hurda-mavi"],
    save.ActiveBusId,
    save.GameTimeMinutes,
    save.GameDay,
    save.LicencePoints,
    save.PoliceRisk,
    save.ShortChangeStreak,
    save.VehicleLockSecondsLeft,
    save.Username,
    save.SavedAtUtc,
    clamped,
    offlineIncome
);
