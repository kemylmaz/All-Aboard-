namespace FullFilled.Api.Dtos;

public record UpgradesDto(int MotorLevel, int SeatLevel, int SoundLevel, bool HasCashRegister);

public record SecondLineDto(bool Unlocked, bool HasDriver);

public record OwnedBusDto(string Id, string Name, string? DriverAssignedId, string Color);

public record RouteMasteryEntryDto(int Level, int Xp);

public record ChanceGameResultDto(
    string Id,
    string GameId,
    string Label,
    decimal Stake,
    decimal Payout,
    decimal Net,
    decimal Multiplier,
    string Tone,
    DateTime CreatedAtUtc,
    // Faz 9: para dışı ödül türü — istemci "money" dışındaki değerler için kendi efektini uygular.
    string RewardType = "money",
    string? CosmeticId = null
);

public record ChanceGamesDto(
    int Day,
    decimal DailyLimitUsed,
    int WheelSpinsToday,
    List<ChanceGameResultDto> RecentResults
);

public record SaveGameRequest(
    int SaveVersion,
    decimal Money,
    int Satisfaction,
    List<decimal> StopsWaiting,
    int PassengersOnBoard,
    int NextStopDropoffs,
    int SeatCapacity,
    UpgradesDto Upgrades,
    Dictionary<string, UpgradesDto>? BusUpgrades,
    string? HiredDriverId,
    SecondLineDto SecondLine,
    bool HasCheckpoint,
    List<OwnedBusDto>? OwnedBuses,
    Dictionary<string, Dictionary<string, string?>>? DriverAssignments,
    Dictionary<string, decimal>? DriverShiftMinutes,
    Dictionary<string, decimal>? DriverMorale,
    Dictionary<string, RouteMasteryEntryDto>? RouteMastery,
    Dictionary<string, string>? TutorialStatus,
    ChanceGamesDto? ChanceGames,
    List<string>? TerminalUpgrades,
    List<string>? UnlockedRoutes,
    string? ActiveRouteId,
    List<string>? OwnedBusIds,
    string? ActiveBusId,
    decimal? GameTimeMinutes = null,
    int? GameDay = null,
    int? LicencePoints = null,
    decimal? PoliceRisk = null,
    int? ShortChangeStreak = null,
    decimal? VehicleLockSecondsLeft = null
);

public record SaveGameResponse(
    decimal Money,
    int Satisfaction,
    List<decimal> StopsWaiting,
    int PassengersOnBoard,
    int NextStopDropoffs,
    int SeatCapacity,
    UpgradesDto Upgrades,
    Dictionary<string, UpgradesDto> BusUpgrades,
    string? HiredDriverId,
    SecondLineDto SecondLine,
    bool HasCheckpoint,
    List<OwnedBusDto> OwnedBuses,
    Dictionary<string, Dictionary<string, string?>> DriverAssignments,
    Dictionary<string, decimal> DriverShiftMinutes,
    Dictionary<string, decimal> DriverMorale,
    Dictionary<string, RouteMasteryEntryDto> RouteMastery,
    Dictionary<string, string> TutorialStatus,
    ChanceGamesDto ChanceGames,
    List<string> TerminalUpgrades,
    List<string> UnlockedRoutes,
    string ActiveRouteId,
    List<string> OwnedBusIds,
    string ActiveBusId,
    decimal GameTimeMinutes,
    int GameDay,
    int LicencePoints,
    decimal PoliceRisk,
    int ShortChangeStreak,
    decimal VehicleLockSecondsLeft,
    string? Username,
    DateTime SavedAtUtc,
    bool Clamped,
    decimal OfflineIncome
);

public record BuyCheckpointResponse(decimal Money, bool HasCheckpoint, string Message);

public record SpinWheelRequest(int GameDay, string? ClientRequestId = null);

public record SpinWheelResponse(
    decimal Money,
    ChanceGamesDto ChanceGames,
    ChanceGameResultDto Result
);

public record PlayPlateRequest(int GameDay, string Guess, string? ClientRequestId = null);

public record PlayPlateResponse(
    decimal Money,
    ChanceGamesDto ChanceGames,
    ChanceGameResultDto Result,
    int PlateDigit,
    string CorrectChoice
);

public record BuyLotteryTicketRequest(int GameDay, string? ClientRequestId = null);

public record BuyLotteryTicketResponse(
    decimal Money,
    ChanceGamesDto ChanceGames,
    ChanceGameResultDto Result
);

public record PlayMiniChanceRequest(int GameDay, string? ClientRequestId = null);

public record PlayMiniChanceResponse(
    decimal Money,
    ChanceGamesDto ChanceGames,
    ChanceGameResultDto Result
);
