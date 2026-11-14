# رفع Cloud SWAT على Railway (خطوة بخطوة)

الإعداد يأخذ تقريبًا ٣٠ دقيقة ويتسوى **مرة وحدة بس**. خلّ هالملف مفتوح، وامشِ عليه بالترتيب.

> **التكلفة:** خطة Railway **Hobby بـ ٥ دولار في الشهر**، وفيها ٥ دولار استخدام. السيرفر هذا خفيف جدًا، فالمفروض ما تدفع أكثر منها. ويطلع لك رابط مجاني فيه https، فما تحتاج تشتري دومين.

---

## ١) ارفع المشروع على GitHub

1. ادخل [github.com/new](https://github.com/new).
2. اكتب اسم الريبو: **`cloud-swat`**، واختر **Public**. لازم يكون عام، لأن الناس بيركّبون الـ plugin منه.
3. اضغط **Create repository**.
4. في صفحة الريبو اضغط **uploading an existing file**، واسحب **كل محتوى المجلد** وأفلته في الصفحة. المقصود الملفات والمجلدات اللي داخله، مو المجلد نفسه.
5. اضغط **Commit changes**.

✅ لازم تشوف في أول الريبو: `Dockerfile` و`railway.json` و`server/` و`plugin/` و`.claude-plugin/`.

> ⚠️ المجلدات اللي أسماؤها تبدأ بنقطة، مثل `.claude-plugin`، أحيانًا ما ترتفع لما تسحبها. إذا ما ظهرت، استخدم **GitHub Desktop** وارفع منه.

---

## ٢) أنشئ المشروع في Railway

1. ادخل [railway.com](https://railway.com) وسجّل بحساب GitHub.
2. اضغط **New Project**، ثم **Deploy from GitHub repo**، واختر `cloud-swat`.
3. بيبدأ البناء. عادي إذا فشل أول مرة، لأنه ناقصه الإعدادات اللي بنحطها تحت.

### خذ رابط موقعك
اضغط على الخدمة، ثم **Settings**، ثم **Networking**، ثم **Generate Domain**.
بيطلع لك رابط مثل: `https://cloud-swat-production.up.railway.app`
**انسخه، لأنك بتحتاجه في كل الخطوات الجاية.** وبنسميه تحت **رابط موقعك**.

### أضف مكان حفظ البيانات (Volume)
اضغط على الخدمة بالزر اليمين، ثم **Attach Volume**. واكتب في **Mount path**: `/data`

> بدون هالخطوة، كل البيانات تنمسح كل ما السيرفر يعيد التشغيل.

---

## ٣) سوِّ تسجيل الدخول بـ GitHub

1. ادخل [github.com/settings/developers](https://github.com/settings/developers)، ثم **OAuth Apps**، ثم **New OAuth App**.
2. عبّي الخانات كذا:
   - **Application name:** `Cloud SWAT`
   - **Homepage URL:** رابط موقعك
   - **Authorization callback URL:** رابط موقعك وبعده `/auth/github/callback`
     مثال: `https://cloud-swat-production.up.railway.app/auth/github/callback`
3. اضغط **Register application**.
4. انسخ **Client ID**.
5. اضغط **Generate a new client secret** وانسخه. ما بيظهر لك مرة ثانية.

---

## ٤) سوِّ تسجيل الدخول بـ Google

1. ادخل [console.cloud.google.com](https://console.cloud.google.com)، وسوِّ **مشروع جديد** اسمه `Cloud SWAT`.
2. من القائمة: **APIs & Services**، ثم **OAuth consent screen**:
   - اختر **External**.
   - App name: `Cloud SWAT`، وحط إيميلك في الخانات المطلوبة.
   - الصلاحيات (Scopes): لا تضيف شي. الأساسية تكفي، وهي `openid` و`email` و`profile`.
   - في الآخر اضغط **Publish app**، عشان أي أحد يقدر يسجل وما يقتصر على حسابك بس.
3. روح لـ **Credentials**، ثم **Create Credentials**، ثم **OAuth client ID**:
   - **Application type:** Web application
   - **Authorized redirect URIs:** رابط موقعك وبعده `/auth/google/callback`
4. اضغط **Create**، وانسخ **Client ID** و**Client secret**.

---

## ٥) حط الإعدادات في Railway

في الخدمة روح لـ **Variables**، ثم **Raw Editor**، والصق هذا بعد ما تعدّل القيم:

```
PUBLIC_URL=https://رابط-موقعك.up.railway.app
SESSION_SECRET=حط-هنا-نص-عشوائي-طويل
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

- **PUBLIC_URL:** رابط موقعك نفسه، **بدون** `/` في آخره.
- **SESSION_SECRET:** نص عشوائي من ٦٤ حرف. تقدر تولّده بهالأمر في الترمنال:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  ولا تشاركه مع أحد أبدًا.

اضغط **Deploy**، وانتظر لين يصير **Active**.

✅ **تأكد:** افتح رابط موقعك وبعده `/healthz`، ولازم يطلع لك `{"ok":true,...}`.
✅ افتح رابط موقعك نفسه، وبتطلع لك الصفحة الرئيسية بالغيوم البرتقالية.

---

## ٦) اربط الـ plugin بموقعك

1. في GitHub افتح الملف `plugin/config.json` واضغط ✏️ عشان تعدّله.
2. غيّر الرابط لرابط موقعك:
   ```json
   { "url": "https://cloud-swat-production.up.railway.app" }
   ```
3. اضغط **Commit changes**.

---

## ٧) جرّبه بنفسك

في **Claude Code** اكتب:
```
/plugin marketplace add cloud-swat/cloud-swat
/plugin install cloud-swat@cloud-swat
```

بعدها:
1. اقفل Claude Code وافتحه من جديد.
2. **بيفتح المتصفح لحاله** على صفحة ربط الجهاز. سجّل دخول بـ GitHub أو Google، وتأكد إن الكود نفس اللي في الترمنال، واضغط **Approve**.
3. بتنتقل لصفحة المهمات، وبتنتظر أول مهمة.
4. ارجع لـ Claude Code واكتب مثلًا: `use the crew to review this project for security issues`
5. **الموقع بيدخل على المهمة لحاله** وبتشوف الفريق يشتغل لايف 🎉

---

## ٨) اختياري: MCP داخل Claude

تحتاجه إذا تبي تسأل Claude عن إحصائياتك، أو تحفظ مهمات من تطبيق Claude العادي.

- **في Claude Code:**
  `claude mcp add --transport http cloud-swat https://رابط-موقعك/mcp`
- **في تطبيق Claude:** Settings، ثم Connectors، ثم **Add custom connector**، والصق `https://رابط-موقعك/mcp`

بتطلع لك صفحة **Connect**، اضغط عليها وخلاص.

---

## إذا صار شي

| المشكلة | الحل |
|---|---|
| البناء فشل في Railway | تأكد إن `Dockerfile` موجود في أول الريبو، مو داخل مجلد ثاني |
| `/healthz` ما يفتح | شيّك إن `SESSION_SECRET` فيه ٣٢ حرف على الأقل، وشوف **Deploy Logs** |
| بعد تسجيل الدخول يطلع خطأ `redirect_uri` | رابط الـ callback في GitHub أو Google لازم يطابق `PUBLIC_URL` حرف بحرف |
| ما ينفتح المتصفح للربط | الرابط مكتوب في Claude Code، انسخه وافتحه بنفسك |
| أبي أوقف التتبع مؤقتًا | شغّل Claude Code ومعه `CLOUD_SWAT_DISABLE=1` |

## مهم للأمان

- **لا تشغّل أكثر من نسخة** من السيرفر. خلها **Replicas = 1**، لأن التحديث اللايف محفوظ في ذاكرة السيرفر.
- `SESSION_SECRET` ومفاتيح OAuth خلها في Railway بس. لا تحطها في الريبو أبدًا.
- المهمات تنحذف تلقائيًا بعد ٣٠ يوم. وتقدر تغيّر المدة بالمتغير `RETENTION_DAYS`.
