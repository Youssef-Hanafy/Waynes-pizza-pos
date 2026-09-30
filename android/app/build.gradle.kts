plugins {
    alias(libs.plugins.android.application)
}

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
        // The POS the app opens. Change it here (and rebuild) if the POS moves to another address.
        buildConfigField("String", "POS_URL", "\"https://app.hanafymedia.com/pos\"")
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
