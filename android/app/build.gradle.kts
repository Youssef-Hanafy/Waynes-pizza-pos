import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val posUrl: String = (localProperties.getProperty("waynesPosUrl")
    ?: providers.gradleProperty("waynesPosUrl").orNull
    ?: "https://app.hanafymedia.com/pos").trim()

android {
    namespace = "com.waynespizza.pos"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.waynespizza.pos"
        minSdk = 26
        targetSdk = 37
        versionCode = 2
        versionName = "1.1"
        // The POS the app opens: the live address unless waynesPosUrl is set in android/local.properties
        // (this Mac only) or gradle.properties.  To try the app in the Android emulator against
        // `npm run dev` on this Mac, add to android/local.properties:
        //     waynesPosUrl=http://10.0.2.2:3000/pos
        // (10.0.2.2 is how the emulator reaches the Mac; plain http is allowed for it in debug builds only.)
        buildConfigField("String", "POS_URL", "\"$posUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            optimization {
                enable = false
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    // Stripe Reader M2 (Bluetooth card reader). https://github.com/stripe/stripe-terminal-android
    implementation("com.stripe:stripeterminal:5.8.1")
}
