namespace FullFilled.Api.Models;

// Tek oyunculuk kayıt (Aşama 5'te hesap sistemine bağlanacak — bkz. ADR-003).
// PlayerId şimdilik tarayıcıda üretilip localStorage'da tutulan bir GUID.
public class GameSave
{
    public string PlayerId { get; set; } = "";
    public int SaveVersion { get; set; } = Data.SchemaVersions.CurrentGameSave;
    public decimal Money { get; set; }
    public int Satisfaction { get; set; }
    public string StopsWaitingJson { get; set; } = "[]";
    public int PassengersOnBoard { get; set; }
    public int NextStopDropoffs { get; set; }
    public int SeatCapacity { get; set; }
    public int MotorLevel { get; set; }
    public int SeatLevel { get; set; }
    public int SoundLevel { get; set; }
    public bool HasCashRegister { get; set; }
    public string BusUpgradesJson { get; set; } = "{}";
    public string? HiredDriverId { get; set; }
    public string OwnedBusesJson { get; set; } = "[]";
    public string DriverAssignmentsJson { get; set; } = "{}";
    public string DriverShiftMinutesJson { get; set; } = "{}";
    /// Faz 5: sofor basina moral (0-100), iyi/kotu gun notuyla degisir.
    public string DriverMoraleJson { get; set; } = "{}";
    /// Faz 6: hat basina mastery seviye/XP.
    public string RouteMasteryJson { get; set; } = "{}";
    /// Rakip firmanın hat başına baskısı: ihmal puanı ve kaybedilen durak sayısı.
    public string RivalJson { get; set; } = "{}";
    /// Faz 8: parca basina tutorial tamamlanma/atlama durumu ("completed"/"skipped").
    public string TutorialStatusJson { get; set; } = "{}";
    public string ChanceGamesJson { get; set; } = "{}";
    public decimal GameTimeMinutes { get; set; } = 480m;
    public int GameDay { get; set; } = 1;
    /// Ehliyet sistemi: sayfa yenileme/yeniden giriş ceza durumunu sıfırlamamalı.
    public int LicencePoints { get; set; }
    public decimal PoliceRisk { get; set; }
    public int ShortChangeStreak { get; set; }
    public decimal VehicleLockSecondsLeft { get; set; }
    public string TerminalUpgradesJson { get; set; } = "[]";
    /// Faz 4: acilan hatlar + aktif hat. Acilis bedeli sunucuda tahsil edilir.
    public string UnlockedRoutesJson { get; set; } = "[\"starter-center\"]";
    public string ActiveRouteId { get; set; } = "starter-center";
    /// Faz 4 garaj: sahip olunan katalog araclari + surulen arac.
    public string OwnedBusIdsJson { get; set; } = "[\"hurda-mavi\"]";
    public string ActiveBusId { get; set; } = "hurda-mavi";
    public bool SecondLineUnlocked { get; set; }
    public bool SecondLineHasDriver { get; set; }
    /// Aşama 5: link=şehir. Küçük harfe normalize edilip benzersizlik burada kontrol edilir.
    public string? Username { get; set; }
    /// Login sistemi: PBKDF2 hash ("salt:hash", base64) — bkz. PasswordHasher.cs. Asla düz metin.
    public string? PasswordHash { get; set; }
    public string? AuthTokenHash { get; set; }
    /// Aşama 5: savunma — korsan sefer yakalanırsa saldıran 2 katını öder (bkz. Program.cs raid).
    public bool HasCheckpoint { get; set; }
    public DateTime SavedAtUtc { get; set; }
}
