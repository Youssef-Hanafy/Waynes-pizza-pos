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
        versionCode = 1
        versionName = "1.0"
        // The POS the app opens. Change it here (and rebuild) if the POS moves to another address.
        buildConfigField("String", "POS_URL", "\"https://waynes-pizza-pos.vercel.app/pos\"")
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
