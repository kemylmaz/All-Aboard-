using System.Text.Json;
using System.Text.Json.Serialization;

namespace FullFilled.Api;

// Doğrulama için gereken ekonomi değerleri `shared/economy.json` içinden yüklenir.
// KURAL: denge değişiklikleri JSON'da yapılır; frontend ve backend aynı kaynağı kullanır.
public static class EconomyConstants
{
    private static readonly Lazy<EconomyConfig> Config = new(LoadConfig);

    public static decimal FareFull => Config.Value.Fare.Full;
    public static int BaseSeatCapacity => Config.Value.Bus.BaseSeatCapacity;
    public static int InitialSatisfaction => Config.Value.Satisfaction.Initial;

    // Bir yolcunun binip inmesi ~3 sn sürüyor (durak molası + yol); bu, oyuncunun mümkün
    // olan en yüksek sürdürülebilir kazanç hızının kaba bir üst sınırıdır.
    public static decimal MaxPlausibleMoneyPerSecond => (BaseSeatCapacity * FareFull) / 3m;

    // MVP sadeleştirmesi: offline gelir için roster ortalamasını kullanıyoruz.
    public static decimal DriverNetFareMultiplier =>
        Config.Value.Drivers.Count == 0
            ? 0m
            : Config.Value.Drivers.Average(d => d.Efficiency * (1m - d.SalaryShare));

    // Gerçekçi ortalama kazanç, teorik tavanın yarısı kadar (her durakta tam dolum olmaz).
    public static decimal DriverIdleIncomePerSecond => MaxPlausibleMoneyPerSecond * 0.5m * DriverNetFareMultiplier;

    public static int OfflineIncomeCapHours => Config.Value.Idle.OfflineCapHours;
    public static decimal GameMinutesPerRealSecond => Config.Value.Time.GameMinutesPerRealSecond;
    public static decimal MainBusDailyGrossIncome => Config.Value.Shifts.MainBusDailyGrossIncome;
    public static decimal ExtraBusDailyGrossIncome => Config.Value.ExtraBuses.DailyGrossIncome;
    public static decimal NightShiftIncomeMultiplier => Config.Value.Shifts.NightIncomeMultiplier;
    public static IReadOnlyList<DriverConfig> Drivers => Config.Value.Drivers;

    public static decimal RaidStealPercent => Config.Value.Social.RaidStealPercent;
    public static decimal RaidStealCap => Config.Value.Social.RaidStealCap;
    public static int RaidDailyLimitPerHost => Config.Value.Social.RaidDailyLimitPerHost;
    public static decimal RaidCatchChanceWithCheckpoint => Config.Value.Social.CheckpointCatchChance;
    public static decimal TipMin => Config.Value.Fare.TipMin;
    public static decimal TipMax => Config.Value.Fare.TipMax;
    public static decimal CheckpointCost => Config.Value.Social.CheckpointCost;
    public static ChanceGamesConfig ChanceGames => Config.Value.ChanceGames;
    public static int MaxMotorLevel => Config.Value.Upgrades.MotorCosts.Count;
    public static int MaxSeatLevel => Math.Max(0, Config.Value.Upgrades.SeatCapacityLevels.Count - 1);
    public static int MaxSoundLevel => Config.Value.Upgrades.SoundCosts.Count;
    public static decimal CashRegisterCost => Config.Value.Upgrades.CashRegisterCost;
    public static decimal SecondLineOpenCost => Config.Value.SecondLine.OpenCost;
    public static decimal SecondLineDriverHireCost => Config.Value.SecondLine.DriverHireCost;
    public static decimal MaxStopWaiting => Config.Value.StopQueue.MaxWaiting;
    public static ProgressionConfig Progression => Config.Value.Progression;
    public static DayGradingConfig DayGrading => Config.Value.DayGrading;
    public static ContractsConfig Contracts => Config.Value.Contracts;
    public static CityEventsConfig CityEvents => Config.Value.CityEvents;
    public static LicenceConfig Licence => Config.Value.Licence;

    // Faz 7: günlük şehir olayı sunucuda üretilir (istemci tahmin edip taklit edemez).
    // Deterministik: aynı (playerId, gameDay) her zaman aynı olayı verir — çift sekme/yenileme
    // tutarlı kalır — ama önceki günle aynı şablonu tekrar etmez (event deck kuralı).
    public static (DailyEventTemplateConfig Primary, string AffectedRouteId, DailyEventTemplateConfig? Secondary) GenerateDailyEvent(string playerId, int gameDay, int playerLevel)
    {
        var templates = CityEvents.Templates;
        var index = DeterministicIndex(playerId, gameDay, templates.Count);
        var yesterdayIndex = DeterministicIndex(playerId, gameDay - 1, templates.Count);
        if (index == yesterdayIndex) index = (index + 1) % templates.Count;

        var routeIds = RouteUnlockCosts.Keys.ToList();
        var routeIndex = DeterministicIndex(playerId, gameDay * 31 + 7, routeIds.Count);
        var affectedRouteId = routeIds[routeIndex];

        DailyEventTemplateConfig? secondary = null;
        if (playerLevel >= CityEvents.SecondEventLevel)
        {
            var secondIndex = DeterministicIndex(playerId, gameDay * 17 + 3, templates.Count);
            if (secondIndex == index) secondIndex = (secondIndex + 1) % templates.Count;
            secondary = templates[secondIndex];
        }

        return (templates[index], affectedRouteId, secondary);
    }

    private static int DeterministicIndex(string playerId, int seed, int modulo)
    {
        if (modulo <= 0) return 0;
        unchecked
        {
            var hash = 17;
            foreach (var ch in playerId) hash = hash * 31 + ch;
            hash = hash * 31 + seed;
            return Math.Abs(hash) % modulo;
        }
    }

    // Faz 4: kontrat şablonu + seviye bandına göre XP/itibar. İstemcinin bildirdiği bonus/aile
    // sunucuda doğrulanır; başarısız/bırakılan kontrat ödül vermez.
    public static ContractFamilyConfig? ContractFamily(string familyId) =>
        Contracts.Families.FirstOrDefault(family => family.Id == familyId);

    public static ContractLevelBandConfig ContractBandForLevel(int level) =>
        Contracts.LevelBands.FirstOrDefault(band => level >= band.MinLevel && level <= band.MaxLevel)
            ?? Contracts.LevelBands[^1];

    public static bool IsValidContractBonusSelection(ContractFamilyConfig family, IReadOnlyList<string> bonusIds) =>
        bonusIds.Count <= 2 && bonusIds.Distinct().All(id => family.BonusPool.Contains(id));

    public static (int Xp, int Reputation) ContractReward(string familyId, IReadOnlyList<string> bonusIds, int playerLevel, bool success)
    {
        var family = ContractFamily(familyId);
        if (family is null || !success) return (0, 0);
        var band = ContractBandForLevel(playerLevel);
        var xpRatio = 1m + bonusIds.Distinct().Sum(id => Contracts.Bonuses.GetValueOrDefault(id)?.XpRatio ?? 0m);
        var xp = (int)Math.Round(family.BaseXp * band.RewardMultiplier * xpRatio, MidpointRounding.AwayFromZero);
        return (xp, family.BaseReputation);
    }

    // Faz 3: not → XP. İstemci aynı eşlemeyi önizler ama otorite backend'dir.
    public static bool IsValidGrade(string grade) => DayGrading.Xp.GradeMultipliers.ContainsKey(grade);
    public static int ShiftXpForGrade(string grade)
    {
        var multiplier = DayGrading.Xp.GradeMultipliers.GetValueOrDefault(grade, 0m);
        return (int)Math.Round(DayGrading.Xp.BaseXp * multiplier, MidpointRounding.AwayFromZero);
    }
    public static IReadOnlyList<decimal> ExtraBusPurchaseCosts => Config.Value.ExtraBuses.PurchaseCosts;
    public static decimal MotorUpgradeCost(int currentLevel, int targetLevel) =>
        SumUpgradeCosts(Config.Value.Upgrades.MotorCosts, currentLevel, targetLevel);
    public static decimal SeatUpgradeCost(int currentLevel, int targetLevel) =>
        SumUpgradeCosts(Config.Value.Upgrades.SeatCosts, currentLevel, targetLevel);
    public static decimal SoundUpgradeCost(int currentLevel, int targetLevel) =>
        SumUpgradeCosts(Config.Value.Upgrades.SoundCosts, currentLevel, targetLevel);
    public static decimal? DriverHireCost(string? driverId) =>
        Config.Value.Drivers.FirstOrDefault(driver => driver.Id == driverId)?.HireCost;
    public static int SeatCapacityForLevel(int seatLevel)
    {
        var levels = Config.Value.Upgrades.SeatCapacityLevels;
        if (levels.Count == 0) return BaseSeatCapacity;
        return levels[Math.Clamp(seatLevel, 0, levels.Count - 1)];
    }

    // Faz 2 — Ekonomi 2.0: başlangıçta ekonomi bütünlük kontrolü. Bozuk veya dengesiz bir
    // economy.json ile sunucu sessizce yanlış tahsilat yapmasın diye fail-fast uygular.
    // Program.cs bunu açılışta çağırır; ihlalde sunucu başlamaz.
    public static void Validate()
    {
        var problems = new List<string>();

        void Require(bool condition, string message)
        {
            if (!condition) problems.Add(message);
        }

        Require(FareFull > 0, "fare.full pozitif olmalı");
        Require(BaseSeatCapacity > 0, "bus.baseSeatCapacity pozitif olmalı");
        Require(MaxPlausibleMoneyPerSecond > 0, "MaxPlausibleMoneyPerSecond pozitif olmalı");

        RequirePositiveIncreasing(Config.Value.Upgrades.MotorCosts, "upgrades.motorCosts", problems);
        RequirePositiveIncreasing(Config.Value.Upgrades.SeatCosts, "upgrades.seatCosts", problems);
        RequirePositiveIncreasing(Config.Value.Upgrades.SoundCosts, "upgrades.soundCosts", problems);
        RequirePositiveIncreasing(Config.Value.ExtraBuses.PurchaseCosts, "extraBuses.purchaseCosts", problems);
        Require(CashRegisterCost > 0, "upgrades.cashRegisterCost pozitif olmalı");

        Require(MainBusDailyGrossIncome > 0, "shifts.mainBusDailyGrossIncome pozitif olmalı");
        Require(ExtraBusDailyGrossIncome > 0, "extraBuses.dailyGrossIncome pozitif olmalı");
        Require(SecondLineOpenCost > 0, "secondLine.openCost pozitif olmalı");
        Require(SecondLineDriverHireCost > 0, "secondLine.driverHireCost pozitif olmalı");

        foreach (var driver in Config.Value.Drivers)
        {
            Require(driver.Efficiency > 0 && driver.Efficiency <= 1, $"driver '{driver.Id}' efficiency 0-1 aralığında olmalı");
            Require(driver.SalaryShare >= 0 && driver.SalaryShare < 1, $"driver '{driver.Id}' salaryShare [0,1) aralığında olmalı");
            Require(driver.HireCost > 0, $"driver '{driver.Id}' hireCost pozitif olmalı");
            Require(driver.DailySalary > 0, $"driver '{driver.Id}' dailySalary pozitif olmalı");
        }

        Require(DayGrading.Xp.BaseXp > 0, "dayGrading.xp.baseXp pozitif olmalı");
        Require(DayGrading.Xp.GradeMultipliers.Count > 0, "dayGrading.xp.gradeMultipliers boş olamaz");

        Require(Contracts.MaxActive > 0, "contracts.maxActive pozitif olmalı");
        Require(Contracts.OfferCount > 0, "contracts.offerCount pozitif olmalı");
        Require(Contracts.LevelBands.Count > 0, "contracts.levelBands boş olamaz");
        Require(Contracts.Families.Count > 0, "contracts.families boş olamaz");
        foreach (var family in Contracts.Families)
        {
            Require(family.BaseXp > 0, $"contract family '{family.Id}' baseXp pozitif olmalı");
            Require(family.BaseMoney > 0, $"contract family '{family.Id}' baseMoney pozitif olmalı");
            Require(family.TargetBase > 0, $"contract family '{family.Id}' targetBase pozitif olmalı");
            Require(family.BonusPool.All(id => Contracts.Bonuses.ContainsKey(id)), $"contract family '{family.Id}' bilinmeyen bonus referansı");
        }

        Require(ChanceGames.MinimumReserve >= 0, "chanceGames.minimumReserve negatif olamaz");
        Require(ChanceGames.LargeWinThreshold > 0, "chanceGames.largeWinThreshold pozitif olmalı");
        // Bir oyunun kendi gunluk hakki, paylasilan gunluk butceyi asarsa ust siniri hic
        // ulasilamaz olur (olu konfigurasyon) — her oyun kendi maxPlaysPerDay'inde en azindan
        // butcenin altinda kalabilmeli.
        Require(ChanceGames.Wheel.MaxSpinsPerDay * ChanceGames.Wheel.Stake <= ChanceGames.DailyBudgetLimit, "chanceGames.wheel gunluk hakki butceyi asiyor");

        Require(CityEvents.Templates.Count > 0, "cityEvents.templates boş olamaz");
        Require(CityEvents.Templates.Select(item => item.Id).Distinct().Count() == CityEvents.Templates.Count, "cityEvents.templates id'leri benzersiz olmalı");
        Require(CityEvents.CounterEffectRatio is > 0 and <= 1, "cityEvents.counterEffectRatio (0,1] aralığında olmalı");
        foreach (var template in CityEvents.Templates)
        {
            Require(template.CounterCost >= 0, $"cityEvent '{template.Id}' counterCost negatif olamaz");
        }

        var thresholds = Config.Value.Progression.LevelThresholds;
        Require(thresholds.Count == Config.Value.Progression.MaxLevel, "progression.levelThresholds uzunluğu maxLevel'a eşit olmalı");
        Require(thresholds.Count > 0 && thresholds[0] == 0, "progression.levelThresholds ilk eşik 0 olmalı");
        for (var i = 1; i < thresholds.Count; i++)
        {
            Require(thresholds[i] > thresholds[i - 1], $"progression.levelThresholds artan olmalı (index {i})");
        }

        if (problems.Count > 0)
        {
            throw new InvalidOperationException(
                "Ekonomi doğrulaması başarısız (shared/economy.json):\n - " + string.Join("\n - ", problems));
        }
    }

    private static void RequirePositiveIncreasing(IReadOnlyList<decimal> costs, string label, List<string> problems)
    {
        if (costs.Count == 0)
        {
            problems.Add($"{label} boş olamaz");
            return;
        }
        for (var i = 0; i < costs.Count; i++)
        {
            if (costs[i] <= 0) problems.Add($"{label}[{i}] pozitif olmalı");
            if (i > 0 && costs[i] < costs[i - 1]) problems.Add($"{label}[{i}] azalıyor — kademeli fiyat bekleniyor");
        }
    }

    private static decimal SumUpgradeCosts(IReadOnlyList<decimal> costs, int currentLevel, int targetLevel)
    {
        var start = Math.Clamp(currentLevel, 0, costs.Count);
        var end = Math.Clamp(targetLevel, start, costs.Count);
        var total = 0m;
        for (var level = start; level < end; level++) total += costs[level];
        return total;
    }

    private static EconomyConfig LoadConfig()
    {
        var path = FindSharedEconomyPath();
        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<EconomyConfig>(json, JsonOptions)
            ?? throw new InvalidOperationException($"Economy config could not be read: {path}");
    }

    private static string FindSharedEconomyPath()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, "shared", "economy.json");
            if (File.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }

        var fromWorkingDirectory = Path.GetFullPath(Path.Combine("..", "..", "shared", "economy.json"));
        if (File.Exists(fromWorkingDirectory)) return fromWorkingDirectory;

        throw new FileNotFoundException("shared/economy.json bulunamadı.");
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    /// Frontend route.ts ROUTE_DEFINITIONS ile senkron tutulmali (id + unlockCost).
    public static readonly Dictionary<string, decimal> RouteUnlockCosts = new()
    {
        ["starter-center"] = 0m,
        ["main-city"] = 25000m,
        ["north-loop"] = 60000m,
        ["premium-outer"] = 400000m,
    };

    /// Frontend content/busCatalog.ts ile senkron tutulmali (id + price).
    public static readonly Dictionary<string, decimal> BusCatalogPrices = new()
    {
        ["hurda-mavi"] = 0m,
        ["hurda-sari"] = 0m,
        ["hurda-yesil"] = 0m,
        ["midibus"] = 22000m,
        ["premium"] = 60000m,
    };

    /// Frontend terminal.ts ile senkron tutulmali (id + cost).
    public static readonly Dictionary<string, decimal> TerminalUpgradeCosts = new()
    {
        ["teaHouse"] = 600m,
        ["toilet"] = 950m,
        ["restaurant"] = 1_650m,
        ["park"] = 2_300m,
        ["billboard"] = 3_400m,
        ["charging"] = 5_200m,
    };
}

public sealed record EconomyConfig(
    FareConfig Fare,
    BusConfig Bus,
    ExtraBusesConfig ExtraBuses,
    List<DriverConfig> Drivers,
    UpgradesConfig Upgrades,
    SatisfactionConfig Satisfaction,
    IdleConfig Idle,
    TimeConfig Time,
    ShiftsConfig Shifts,
    SocialConfig Social,
    ChanceGamesConfig ChanceGames,
    SecondLineConfig SecondLine,
    StopQueueConfig StopQueue,
    ProgressionConfig Progression,
    DayGradingConfig DayGrading,
    ContractsConfig Contracts,
    CityEventsConfig CityEvents,
    LicenceConfig Licence
);

public sealed record LicenceConfig(
    int MaxPoints,
    decimal SuspensionSeconds,
    decimal SuspensionFine,
    LicenceOffenceConfig Speeding,
    LicenceOffenceConfig OffRoute,
    LicenceOffenceConfig Overflow,
    LicenceOffenceConfig ShortChange,
    decimal RiskDecayPerSecond
);

public sealed record LicenceOffenceConfig(
    int Points,
    decimal Fine,
    decimal Risk = 0,
    decimal RiskPerSecond = 0,
    decimal RiskThreshold = 0,
    int Count = 0
);

// Faz 7: canlı şehir event yönetmeni. Sekiz şablon; her biri talep/risk/ücret/memnuniyet
// eksenlerinde küçük bir modifier taşır — "hazırlık" karşı hamlesi risk/memnuniyet kaybını
// yarıya indirir (counterEffectRatio), pozitif eksenler (talep/ücret) dokunulmaz kalır.
public sealed record CityEventsConfig(int SecondEventLevel, decimal CounterEffectRatio, List<DailyEventTemplateConfig> Templates);

public sealed record DailyEventTemplateConfig(
    string Id,
    string Severity,
    decimal DemandDelta,
    decimal RiskDelta,
    decimal FareDelta,
    decimal SatisfactionDrift,
    decimal CounterCost
);

// Faz 4: kontrat motoru. Şablonlar (aileler) + seviye bandı + bonus kombinasyonu şeklinde
// tanımlanır; sunucu bu kaynaktan XP/itibarı doğrular (istemci parametreleri sadece etiket).
public sealed record ContractsConfig(
    int MaxActive,
    int OfferCount,
    int RecentPoolSize,
    List<ContractLevelBandConfig> LevelBands,
    List<ContractFamilyConfig> Families,
    Dictionary<string, ContractBonusConfig> Bonuses
);

public sealed record ContractLevelBandConfig(int MinLevel, int MaxLevel, decimal TargetMultiplier, decimal RewardMultiplier);

public sealed record ContractFamilyConfig(
    string Id,
    string GoalType,
    decimal TargetBase,
    decimal BaseMoney,
    int BaseXp,
    int BaseReputation,
    int MinLevel,
    List<string> BonusPool
);

public sealed record ContractBonusConfig(decimal MoneyRatio, decimal XpRatio);

public sealed record DayGradingConfig(DayGradingXpConfig Xp);

public sealed record DayGradingXpConfig(decimal BaseXp, Dictionary<string, decimal> GradeMultipliers);

public sealed record ProgressionConfig(
    int MaxLevel,
    List<int> LevelThresholds,
    Dictionary<string, int> MilestoneXp,
    List<int> SkillPointLevels,
    Dictionary<string, UnlockRuleConfig> Unlocks
);

public sealed record UnlockRuleConfig(int Level, List<string> Milestones);

public sealed record FareConfig(decimal Full, decimal Student, decimal TipMin, decimal TipMax);

public sealed record BusConfig(int BaseSeatCapacity, decimal BaseSpeedMetersPerSec);

public sealed record ExtraBusesConfig(
    List<decimal> PurchaseCosts,
    List<string> Colors,
    List<string> Names,
    decimal IdleIncomePerSecond,
    decimal DailyGrossIncome
);

public sealed record DriverConfig(
    string Id,
    string Name,
    string Nickname,
    decimal SpeedMultiplier,
    decimal Efficiency,
    decimal SalaryShare,
    decimal HireCost,
    string PortraitPath,
    decimal DailySalary
);

public sealed record UpgradesConfig(
    List<decimal> MotorCosts,
    decimal MotorSpeedBonusPerLevel,
    List<decimal> SeatCosts,
    List<int> SeatCapacityLevels,
    List<decimal> SoundCosts,
    decimal SoundSatisfactionPerSecondPerLevel,
    decimal CashRegisterCost
);

public sealed record SatisfactionConfig(int Initial);

public sealed record SecondLineConfig(decimal OpenCost, decimal DriverHireCost);

public sealed record StopQueueConfig(decimal MaxWaiting);

public sealed record IdleConfig(int OfflineCapHours);

public sealed record TimeConfig(decimal GameMinutesPerRealSecond, int NightStartHour, int NightEndHour);

public sealed record ShiftsConfig(
    List<ShiftSlotConfig> Slots,
    decimal MainBusDailyGrossIncome,
    decimal NightIncomeMultiplier,
    decimal IllegalNightPoliceRiskPerSecond
);

public sealed record ShiftSlotConfig(string Id, string Label, int StartHour, int EndHour, bool Legal);

public sealed record SocialConfig(
    decimal CheckpointCost,
    decimal CheckpointCatchChance,
    int RaidDailyLimitPerHost,
    decimal RaidStealPercent,
    decimal RaidStealCap
);

public sealed record ChanceGamesConfig(
    decimal DailyBudgetLimit,
    int RecentResultLimit,
    decimal MinimumReserve,
    decimal LargeWinThreshold,
    WheelGameConfig Wheel
);

public sealed record WheelGameConfig(
    decimal Stake,
    int MaxSpinsPerDay,
    List<WheelSegmentConfig> Segments
);

public sealed record WheelSegmentConfig(
    string Id,
    string Label,
    decimal Multiplier,
    decimal Weight,
    string Tone
);





