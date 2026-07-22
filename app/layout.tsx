import './globals.css'
import PasswordGate from './components/PasswordGate'

export const metadata = {
  title: 'Timeleft Review Analyzer',
  description: 'Analyze app store reviews for themes, sentiment, and trends',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <PasswordGate>{children}</PasswordGate>
      </body>
    </html>
  )
}
