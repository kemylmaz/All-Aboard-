using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FullFilled.Api.Data;
using FullFilled.Api.Dtos;
using FullFilled.Api.Models;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;

namespace FullFilled.Api.Services;

// Faz 9 — Şans oyunları 2.0. "Korunacak" (faz-plani.md): ayrı merkez, sunucu sonucu, bütçe
// limiti, çark/plaka/piyango dokunulmadı. "Değişecek" burada: kupon gerçek gün/kontrat
// performansına bağlanır, tombala bugünün gerçek şehir olayıyla kutu doldurur, ödüllere
// para-dışı türler eklendi, level kilidi + güvenli rezerv var, büyük kazanç audit'e yazılır.
// Hiçbir ödül türü XP/level/mastery vermez — kısayol yoktur.
public static class ChanceGameService
{
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> PlayerLocks = new();

    private static readonly JsonSerializerOptions ResponseJsonOptions = new(JsonSerializerDefaults.Web);

    public static Task<IResult> SpinWheelAsync(string playerId, SpinWheelRequest request, FullFilledDbContext db, ProgressionService service) =>
        RunForPlayerAsync(playerId, "wheel", request.ClientRequestId, $"wheel:{request.GameDay}", db, async save =>
        {
            var config = EconomyConstants.ChanceGames;
            var wheel = config.Wheel;
            var chanceGames = NormalizeChanceGames(ParseChanceGames(save.ChanceGamesJson), request.GameDay);

            var limitError = await ValidatePlayAsync(playerId, save.Money, chanceGames, wheel.Stake, chanceGames.WheelSpinsToday, wheel.MaxSpinsPerDay, config, service, db, "Bugun Mahalle Carki hakkin doldu.", $"Cark icin en az {wheel.Stake:N0} TL lazim.");
            if (limitError is not null) return limitError;

            var segment = PickWeighted(wheel.Segments, s => s.Weight);
            var payout = Math.Round(wheel.Stake * segment.Multiplier, 2);
            var net = payout - wheel.Stake;
            save.Money = Math.Max(0, save.Money + net);

            var result = NewResult("wheel", segment.Label, wheel.Stake, payout, net, segment.Multiplier, segment.Tone);
            chanceGames = AddChanceResult(chanceGames with
            {
                DailyLimitUsed = chanceGames.DailyLimitUsed + wheel.Stake,
                WheelSpinsToday = chanceGames.WheelSpinsToday + 1,
            }, result, config.RecentResultLimit);

            save.ChanceGamesJson = JsonSerializer.Serialize(chanceGames);
            save.SavedAtUtc = DateTime.UtcNow;
            await LogLargeWinIfNeededAsync(db, playerId, result, save.Money, config);
            var response = new SpinWheelResponse(save.Money, chanceGames, result);
            return Results.Ok(response);
        });

    private static async Task LogLargeWinIfNeededAsync(FullFilledDbContext db, string playerId, ChanceGameResultDto result, decimal balanceAfter, ChanceGamesConfig config)
    {
        if (result.Payout < config.LargeWinThreshold) return;
        var idempotencyKey = $"chance_large_win:{result.Id}";
        if (await db.GameplayEvents.AnyAsync(e => e.PlayerId == playerId && e.IdempotencyKey == idempotencyKey)) return;
        db.GameplayEvents.Add(new GameplayEvent
        {
            PlayerId = playerId,
            IdempotencyKey = idempotencyKey,
            Type = "chance_large_win",
            Category = "economy_audit",
            DataJson = JsonSerializer.Serialize(new { gameId = result.GameId, label = result.Label, payout = result.Payout }),
            Amount = result.Payout,
            Balance = balanceAfter,
            Source = result.GameId,
            ClientBuild = "server",
            DeviceClass = "unknown",
            Locale = "tr",
            ClientAtUtc = result.CreatedAtUtc,
        });
    }

    private static async Task<IResult> RunForPlayerAsync(
        string playerId,
        string gameId,
        string? clientRequestId,
        string requestFingerprint,
        FullFilledDbContext db,
        Func<GameSave, Task<IResult>> play)
    {
        var playerLock = PlayerLocks.GetOrAdd(playerId, _ => new SemaphoreSlim(1, 1));
        await playerLock.WaitAsync();
        try
        {
            var requestId = string.IsNullOrWhiteSpace(clientRequestId) ? null : clientRequestId.Trim();
            var requestHash = Hash($"{playerId}:{gameId}:{requestFingerprint}");

            if (requestId is not null)
            {
                var previous = await db.ChanceGameTransactions.FirstOrDefaultAsync(t => t.PlayerId == playerId && t.ClientRequestId == requestId);
                if (previous is not null)
                {
                    if (previous.RequestHash != requestHash)
                    {
                        return Results.Conflict(new { message = "Bu istek anahtari farkli bir sans oyunu istegi icin kullanilmis." });
                    }

                    return Results.Content(previous.ResponseJson, "application/json");
                }
            }

            var save = await db.GameSaves.FindAsync(playerId);
            if (save is null) return Results.NotFound();

            var result = await play(save);

            if (requestId is not null && IsSuccess(result))
            {
                db.ChanceGameTransactions.Add(new ChanceGameTransaction
                {
                    Id = Guid.NewGuid().ToString("N"),
                    PlayerId = playerId,
                    ClientRequestId = requestId,
                    GameId = gameId,
                    RequestHash = requestHash,
                    ResponseJson = ExtractResponseJson(result),
                    CreatedAtUtc = DateTime.UtcNow,
                });
            }

            await db.SaveChangesAsync();
            return result;
        }
        finally
        {
            playerLock.Release();
        }
    }

    /// Faz 9: seviye kilidi + güvenli rezerv, mevcut gün limiti/hak kontrolüne eklendi.
    private static async Task<IResult?> ValidatePlayAsync(
        string playerId,
        decimal money,
        ChanceGamesDto chanceGames,
        decimal stake,
        int playsToday,
        int maxPlaysPerDay,
        ChanceGamesConfig config,
        ProgressionService service,
        FullFilledDbContext db,
        string maxReachedMessage,
        string insufficientMoneyMessage)
    {
        var requiredLevel = EconomyConstants.Progression.Unlocks.GetValueOrDefault("chanceGames")?.Level ?? 1;
        if (requiredLevel > 1)
        {
            var progression = await service.EnsureAsync(playerId);
            if (progression.Level < requiredLevel)
            {
                return Results.BadRequest(new { message = $"Şans oyunları merkezi seviye {requiredLevel}'de açılır." });
            }
        }

        if (money < stake) return Results.BadRequest(new { message = insufficientMoneyMessage });
        if (money - stake < config.MinimumReserve) return Results.BadRequest(new { message = "Bu oyun kasandaki güvenli rezervin altına düşürür." });
        if (playsToday >= maxPlaysPerDay) return Results.BadRequest(new { message = maxReachedMessage });
        if (chanceGames.DailyLimitUsed + stake > config.DailyBudgetLimit) return Results.BadRequest(new { message = "Gunluk sans oyunu limitin doldu." });
        return null;
    }

    private static bool IsSuccess(IResult result) => result is IStatusCodeHttpResult statusCodeResult
        ? statusCodeResult.StatusCode is null or >= 200 and < 300
        : result is not IValueHttpResult { Value: null };

    private static string ExtractResponseJson(IResult result)
    {
        if (result is IValueHttpResult valueResult)
        {
            return JsonSerializer.Serialize(valueResult.Value, ResponseJsonOptions);
        }

        throw new InvalidOperationException("Chance game response could not be serialized.");
    }

    private static ChanceGameResultDto NewResult(string gameId, string label, decimal stake, decimal payout, decimal net, decimal multiplier, string tone, string rewardType = "money", string? cosmeticId = null) =>
        new(Guid.NewGuid().ToString("N"), gameId, label, stake, payout, net, multiplier, tone, DateTime.UtcNow, rewardType, cosmeticId);

    private static ChanceGamesDto NewChanceGamesState(int day) => new(day, 0m, 0, []);

    private static ChanceGamesDto ParseChanceGames(string? chanceGamesJson)
    {
        if (string.IsNullOrWhiteSpace(chanceGamesJson) || chanceGamesJson == "{}") return NewChanceGamesState(day: 1);
        try
        {
            return JsonSerializer.Deserialize<ChanceGamesDto>(chanceGamesJson) ?? NewChanceGamesState(day: 1);
        }
        catch
        {
            return NewChanceGamesState(day: 1);
        }
    }

    private static ChanceGamesDto NormalizeChanceGames(ChanceGamesDto chanceGames, int day)
    {
        if (chanceGames.Day != day) return NewChanceGamesState(day);
        return chanceGames with
        {
            DailyLimitUsed = Math.Max(0, chanceGames.DailyLimitUsed),
            WheelSpinsToday = Math.Max(0, chanceGames.WheelSpinsToday),
            RecentResults = chanceGames.RecentResults ?? [],
        };
    }

    private static ChanceGamesDto AddChanceResult(ChanceGamesDto chanceGames, ChanceGameResultDto result, int recentResultLimit)
    {
        var results = new List<ChanceGameResultDto> { result };
        results.AddRange(chanceGames.RecentResults ?? []);
        return chanceGames with { RecentResults = results.Take(recentResultLimit).ToList() };
    }

    private static T PickWeighted<T>(IReadOnlyList<T> items, Func<T, decimal> weightSelector)
    {
        if (items.Count == 0) throw new InvalidOperationException("Weighted chance list is empty.");
        var totalWeight = items.Sum(item => Math.Max(0, weightSelector(item)));
        if (totalWeight <= 0) return items[0];

        var roll = (decimal)RandomNumberGenerator.GetInt32(0, int.MaxValue) / int.MaxValue * totalWeight;
        foreach (var item in items)
        {
            roll -= Math.Max(0, weightSelector(item));
            if (roll <= 0) return item;
        }

        return items[^1];
    }

    private static string Hash(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(bytes);
    }
}
