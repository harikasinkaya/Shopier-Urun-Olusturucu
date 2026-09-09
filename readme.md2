Shopier mağazanızda tek seferde yüzlerce ürün açmanızı sağlayan, tek dosyalık (index.js) localhost paneli. Resmi Shopier API kullanır, ek bağımlılık gerektirmez.

Örnek: Apicloud Bakiyesi %para% TL şablonuyla 100 TL'den 2000 TL'ye kadar 1901 ürünü sırayla açar.

Özellikler
%para% yer tutuculu ürün adı şablonu, başlangıç-bitiş-artış aralığı (sadece tam sayı, küsurat girilemez)
Ayarlanabilir bekleme süresi + otomatik jitter (tehlikeli bölgenin altında onay ister)
429'da otomatik bekle-devam, art arda hatada güvenli durdurma
Her ürün için gerçek ürün ID ve linki loglanır, kaldığı fiyattan devam edilebilir
Bağlantı test düğmesi, canlı ilerleme ve ham API yanıtı görüntüleyici
Koyu temalı, tek sayfalık sade arayüz
Gereksinimler
Node.js 20+
Shopier PAT: Hesabım > Hesap Güvenliği'nden 2FA açılır, Hesabım > Personal Access Token bölümünden üretilir
Herkese açık bir ürün görseli URL'si (tüm ürünlerde aynı görsel kullanılır)
Kurulum ve kullanım
node index.js
Tarayıcıda http://localhost:3000 açılır:

PAT ve görsel URL girilip Bağlantıyı test et ile doğrulanır
Ürün adı şablonu ile fiyat aralığı yazılır, Kontrol et ile adet ve tahmini süre görülür
Başlat ile kuyruk çalışır, istenirse Durdur ile kalınan fiyattan devam edilir
Limitler
Resmi API limiti dakikada 200 istektir. Önerilen bekleme 3000-5000ms, alt sınır 500ms'dir. Token yalnızca işlem belleğinde tutulur, dosyaya yazılmaz.

Uyarı
Toplu ürün açılışı Shopier kullanım koşullarını ihlal edebilir ve mağaza kısıtına yol açabilir. Önce tek ürünle test edin. Kullanım sorumluluğu size aittir.
